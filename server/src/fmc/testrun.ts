/**
 * Unattended Revit tests (F75): the pure parts. Scenarios are data (tests/revit/*.json); a run keeps a checkpoint, so a
 * run that stops for any reason (sleep, shutdown, a crash) carries on where it was. Nothing here touches Revit, files or
 * the clock: the runner (testrun_runner.ts) passes them in, and testrun.test.ts checks them with stand-ins.
 *
 * A scenario:
 *   { schema, id, title, features?, needs?: ["navisworks"|"rhino"|"robot"], revit?: false, skip?: "why",
 *     setup: [action], steps: [action], teardown: [action] }
 * An action is one of
 *   { id?, tool: "fmc_room", args: {...} }          a CLI tool call (node build/fmc/cli.js <tool>, JSON on stdin)
 *   { id?, revit: "fmc_element_facts", params }     a read-only Revit command (READ_ONLY_REVIT only)
 *   { id?, read_json: "<file>" }                    reads a JSON file a step wrote (a build record)
 *   { id?, runner: "open_in_revit", path }          the runner's own Revit restarted with this scratch file open
 *   { runner: "close_revit" }                       the runner's Revit closed without saving
 * with optional checks, expect_error, when (a check on earlier replies), repeat_until ({ check, max }) and timeout_s.
 * Strings may hold {{run}}, {{scenario}}, {{attempt}}, {{scratch}}, {{staging}}, {{batch_dir}}, {{chaintests}},
 * {{templates}}, {{kit}}, {{project_template}}, {{scenarios_dir}} and {{steps.<id>.<path>}} (an earlier reply).
 */

export const SCENARIO_SCHEMA = "fmc-testrun/0.1";
export const STATE_SCHEMA = "fmc-testrun-state/0.1";

/** Apps a scenario can need besides Revit; it is skipped, with the reason, when the app isn't open. */
export const NEEDS_APPS = ["navisworks", "rhino", "robot"] as const;
export type NeedsApp = (typeof NEEDS_APPS)[number];

/** Revit commands a scenario may send directly. Read-only, every one (a test checks none is a write). */
export const READ_ONLY_REVIT = ["fmc_document_info", "fmc_element_facts", "fmc_design_options", "fmc_mep_facts"] as const;

export const RUNNER_ACTIONS = ["open_in_revit", "close_revit"] as const;

/** The tools `node build/fmc/cli.js <tool>` runs (a test keeps this list in step with cli.ts). fmc_testrun isn't one: no runs inside runs. */
export const CLI_TOOLS = [
  "fmc_file", "fmc_family", "fmc_project", "fmc_template", "fmc_library", "fmc_qa", "fmc_material", "fmc_sheets", "fmc_annotate",
  "fmc_issue", "fmc_links", "fmc_selftest", "fmc_workshare", "fmc_review", "fmc_report", "fmc_doc", "fmc_revit", "fmc_brief",
  "fmc_scripts", "fmc_systems", "fmc_build", "fmc_ai", "fmc_recipe", "fmc_robot", "fmc_navis", "fmc_rhino", "fmc_legend", "fmc_apps",
  "fmc_flow", "fmc_select", "fmc_find", "fmc_tree", "fmc_room", "fmc_casework", "fmc_ceiling", "fmc_schedules", "fmc_changes", "fmc_balance", "fmc_powerbi", "fmc_tables", "fmc_calc"];

/** A step that fails is run once more from its scenario's setup; an interruption (sleep, shutdown) doesn't count. */
export const MAX_TRIES = 2;
export const MAX_INTERRUPTIONS = 3;
/** A heartbeat older than this means the runner stopped (the PC slept or shut down, or the process ended). */
export const GAP_MS = 3 * 60 * 1000;

export interface Check {
  path?: string;
  equals?: unknown;
  at_least?: number;
  at_most?: number;
  contains?: string | number;
  matches?: string;
  exists?: boolean;
  no_error?: boolean;
  is_error?: boolean;
}

export interface Action {
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  revit?: string;
  params?: Record<string, unknown>;
  read_json?: string;
  runner?: (typeof RUNNER_ACTIONS)[number];
  path?: string;
  checks?: Check[];
  expect_error?: boolean;
  when?: Check;
  repeat_until?: { check: Check; max: number };
  timeout_s?: number;
  note?: string;
}

export interface Scenario {
  schema: string;
  id: string;
  title: string;
  features?: string[];
  needs?: NeedsApp[];
  /** false: needs no Revit (an offline tool); the runner doesn't start one for it. */
  revit?: boolean;
  /** Set: the scenario is listed and skipped with this reason (a tool not on main yet). */
  skip?: string;
  setup: Action[];
  steps: Action[];
  teardown: Action[];
}

const CHECK_KEYS = new Set(["path", "equals", "at_least", "at_most", "contains", "matches", "exists", "no_error", "is_error"]);
const ACTION_KEYS = new Set(["id", "tool", "args", "revit", "params", "read_json", "runner", "path", "checks", "expect_error", "when", "repeat_until", "timeout_s", "note"]);

function checkProblems(c: unknown, where: string): string[] {
  if (!c || typeof c !== "object" || Array.isArray(c)) return [`${where}: a check is an object`];
  const o = c as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!CHECK_KEYS.has(k)) out.push(`${where}: unknown check key "${k}"`);
  const tests = ["equals", "at_least", "at_most", "contains", "matches", "exists", "no_error", "is_error"].filter((k) => k in o);
  if (!tests.length) out.push(`${where}: a check says what to expect (equals, at_least, at_most, contains, matches, exists, no_error or is_error)`);
  if (tests.some((k) => !["no_error", "is_error"].includes(k)) && typeof o.path !== "string") out.push(`${where}: give the reply's path to check`);
  if ("at_least" in o && typeof o.at_least !== "number") out.push(`${where}: at_least is a number`);
  if ("at_most" in o && typeof o.at_most !== "number") out.push(`${where}: at_most is a number`);
  if ("matches" in o) { try { new RegExp(String(o.matches)); } catch { out.push(`${where}: matches is not a valid pattern`); } }
  return out;
}

/**
 * A scenario file checked: its shape, every action's kind, tool names against the CLI's list, no `revit` argument (the
 * runner alone says which Revit), direct Revit commands only from the read-only list. Returns the scenario or problems.
 */
export function parseScenario(text: string, knownTools: string[]): { scenario: Scenario | null; problems: string[] } {
  let raw: any;
  try { raw = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { return { scenario: null, problems: [`Not JSON: ${(e as Error).message}`] }; }
  const p: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { scenario: null, problems: ["A scenario is a JSON object"] };
  if (raw.schema !== SCENARIO_SCHEMA) p.push(`schema must be "${SCENARIO_SCHEMA}"`);
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) p.push("id: letters, digits, _ and - (at most 64)");
  if (typeof raw.title !== "string" || !raw.title.trim()) p.push("title is required");
  if (raw.needs !== undefined && (!Array.isArray(raw.needs) || raw.needs.some((n: unknown) => !NEEDS_APPS.includes(n as NeedsApp))))
    p.push(`needs: a list of ${NEEDS_APPS.join(", ")}`);
  if (raw.skip !== undefined && (typeof raw.skip !== "string" || !raw.skip.trim())) p.push("skip: the reason, as text");
  const ids = new Set<string>();
  for (const part of ["setup", "steps", "teardown"] as const) {
    if (raw[part] === undefined) { raw[part] = []; continue; }
    if (!Array.isArray(raw[part])) { p.push(`${part} is a list`); continue; }
    raw[part].forEach((a: any, i: number) => {
      const where = `${part}[${i}]${a?.id ? ` (${a.id})` : ""}`;
      if (!a || typeof a !== "object" || Array.isArray(a)) { p.push(`${where}: an action is an object`); return; }
      for (const k of Object.keys(a)) if (!ACTION_KEYS.has(k)) p.push(`${where}: unknown key "${k}"`);
      const kinds = ["tool", "revit", "read_json", "runner"].filter((k) => a[k] !== undefined);
      if (kinds.length !== 1) p.push(`${where}: exactly one of tool, revit, read_json or runner`);
      if (a.id !== undefined) {
        if (typeof a.id !== "string" || !/^[A-Za-z0-9_]{1,40}$/.test(a.id)) p.push(`${where}: id is letters, digits and _`);
        else if (ids.has(a.id)) p.push(`${where}: id ${a.id} is used twice`);
        else ids.add(a.id);
      }
      if (a.tool !== undefined) {
        if (!knownTools.includes(a.tool)) p.push(`${where}: ${a.tool} is not a CLI tool`);
        if (a.args !== undefined && (typeof a.args !== "object" || Array.isArray(a.args))) p.push(`${where}: args is an object`);
        if (a.args && "revit" in a.args) p.push(`${where}: no "revit" argument: the runner sends every call to its own Revit`);
      }
      if (a.revit !== undefined && !(READ_ONLY_REVIT as readonly string[]).includes(a.revit))
        p.push(`${where}: ${a.revit} is not one of the read-only Revit commands (${READ_ONLY_REVIT.join(", ")})`);
      if (a.runner !== undefined) {
        if (!(RUNNER_ACTIONS as readonly string[]).includes(a.runner)) p.push(`${where}: runner is one of ${RUNNER_ACTIONS.join(", ")}`);
        if (a.runner === "open_in_revit" && typeof a.path !== "string") p.push(`${where}: open_in_revit needs the path`);
      }
      if (a.read_json !== undefined && typeof a.read_json !== "string") p.push(`${where}: read_json is a file path`);
      if (a.checks !== undefined) {
        if (!Array.isArray(a.checks)) p.push(`${where}: checks is a list`);
        else a.checks.forEach((c: unknown, j: number) => p.push(...checkProblems(c, `${where} check ${j + 1}`)));
      }
      if (a.when !== undefined) p.push(...checkProblems(a.when, `${where} when`));
      if (a.repeat_until !== undefined) {
        if (!a.repeat_until || typeof a.repeat_until !== "object") p.push(`${where}: repeat_until is { check, max }`);
        else {
          p.push(...checkProblems(a.repeat_until.check, `${where} repeat_until`));
          if (!Number.isInteger(a.repeat_until.max) || a.repeat_until.max < 1 || a.repeat_until.max > 500) p.push(`${where}: repeat_until.max is 1-500`);
        }
      }
      if (a.timeout_s !== undefined && (typeof a.timeout_s !== "number" || a.timeout_s <= 0)) p.push(`${where}: timeout_s is a positive number`);
    });
  }
  const needsRevit = raw.revit !== false;
  if (!needsRevit) {
    for (const part of ["setup", "steps", "teardown"] as const)
      for (const a of Array.isArray(raw[part]) ? raw[part] : [])
        if (a && (a.revit !== undefined || a.runner !== undefined)) p.push(`${part}: a scenario with revit false can't use Revit actions`);
  }
  return p.length ? { scenario: null, problems: p } : { scenario: raw as Scenario, problems: [] };
}

// ---------------------------------------------------------------- values in replies and templates

const PATH_PART = /^(?:([^.[\]]+)|\[([^\]=^]+)(\^?=)([^\]]*)\])(?:\.(?=[^.])|(?=\[)|$)/;

/**
 * The value at a dotted path ("elements.0.unique_id"); undefined when any part is missing or the path is malformed.
 * In a list, "[key=value]" is the first item whose key is that value (as text) and "[key^=value]" the first whose key
 * starts with it: "lines[check^=Hosts].state" is the state of a gate's host line, wherever it is in the list.
 */
export function getPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: any = root;
  let rest = path;
  while (rest.length) {
    const m = PATH_PART.exec(rest);
    if (!m) return undefined;
    rest = rest.slice(m[0].length);
    if (cur === null || cur === undefined) return undefined;
    if (m[2] !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      const key = m[2].trim(), want = m[4].trim(), starts = m[3] === "^=";
      cur = cur.find((x) => x && typeof x === "object" && x[key] !== undefined && x[key] !== null &&
        (starts ? String(x[key]).startsWith(want) : String(x[key]) === want));
      continue;
    }
    const part = m[1];
    if (Array.isArray(cur) && part === "length") { cur = cur.length; continue; }
    if (typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Fills {{name}} and {{steps.<id>.<path>}} in every string of a value. A string that is one placeholder alone takes the
 * value itself (a list stays a list). An unknown name throws, so a step never runs with a half-filled argument.
 */
export function substitute(value: unknown, vars: Record<string, unknown>): unknown {
  const lookup = (name: string): unknown => {
    const v = name.includes(".") ? getPath(vars, name) : vars[name];
    if (v === undefined) throw new Error(`Unresolved {{${name}}}`);
    return v;
  };
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
    if (whole) return lookup(whole[1]);
    return value.replace(PLACEHOLDER, (_m, name) => {
      const v = lookup(name);
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

/** What a step got back: the process's exit code (0 done, 1 refused or failed) and the JSON it printed. */
export interface Reply { exit: number; body: unknown }

export function isErrorReply(r: Reply): boolean {
  const b = r.body as Record<string, unknown> | null;
  return r.exit !== 0 || (!!b && typeof b === "object" && (b.error !== undefined || b.refused === true));
}

function short(v: unknown, max = 300): string {
  let s: string;
  try { s = v === undefined ? "(missing)" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined) s = String(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export interface CheckResult { ok: boolean; expected: string; got: string }

/** One check on a reply (or, for `when`, on { steps }). */
export function evalCheck(c: Check, reply: Reply): CheckResult {
  if (c.no_error) {
    const ok = !isErrorReply(reply);
    const b = reply.body as any;
    return { ok, expected: "no error", got: ok ? "no error" : `exit ${reply.exit}: ${short(b?.error ?? b?.reasons ?? b)}` };
  }
  if (c.is_error) {
    const ok = isErrorReply(reply);
    return { ok, expected: "a refusal or error", got: ok ? "refused or failed" : `no error: ${short(reply.body, 160)}` };
  }
  const path = c.path ?? "";
  const v = getPath(reply.body, path);
  const at = path ? `${path} ` : "";
  if ("exists" in c) {
    const ok = (v !== undefined && v !== null) === !!c.exists;
    return { ok, expected: `${at}${c.exists ? "present" : "absent"}`, got: short(v) };
  }
  if ("equals" in c) {
    const ok = JSON.stringify(v) === JSON.stringify(c.equals);
    return { ok, expected: `${at}= ${short(c.equals)}`, got: short(v) };
  }
  const size = (x: unknown) => Array.isArray(x) ? x.length : typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : NaN;
  if ("at_least" in c) {
    const n = size(v);
    return { ok: Number.isFinite(n) && n >= (c.at_least as number), expected: `${at}at least ${c.at_least}`, got: Array.isArray(v) ? `${v.length} items` : short(v) };
  }
  if ("at_most" in c) {
    const n = size(v);
    return { ok: Number.isFinite(n) && n <= (c.at_most as number), expected: `${at}at most ${c.at_most}`, got: Array.isArray(v) ? `${v.length} items` : short(v) };
  }
  if ("contains" in c) {
    const want = c.contains as string | number;
    const ok = Array.isArray(v) ? v.some((x) => x === want || (typeof x === "string" && typeof want === "string" && x.includes(want)))
      : typeof v === "string" ? v.includes(String(want)) : false;
    return { ok, expected: `${at}contains ${short(want)}`, got: short(v) };
  }
  if ("matches" in c) {
    const ok = typeof v === "string" && new RegExp(String(c.matches)).test(v);
    return { ok, expected: `${at}matches /${c.matches}/`, got: short(v) };
  }
  return { ok: false, expected: "a known check", got: short(c) };
}

/** A step's checks: its own, else "no error" (or "an error" when it expects one). */
export function stepChecks(a: Action): Check[] {
  if (a.checks?.length) return a.expect_error && !a.checks.some((c) => c.is_error) ? [{ is_error: true }, ...a.checks] : a.checks;
  return [a.expect_error ? { is_error: true } : { no_error: true }];
}

// ---------------------------------------------------------------- power

export interface PowerStatus {
  /** ACLineStatus: 0 on battery, 1 on mains, 255 unknown. */
  ac: number;
  battery_flag: number;
  percent: number;
  /** SystemStatusFlag: bit 1 (value 1) is battery saver / energy saver on. */
  system_status_flag: number;
}

/** "AC BatteryFlag Percent SystemStatusFlag", as the PowerShell probe prints it; null when unreadable. */
export function parsePowerLine(line: string): PowerStatus | null {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line ?? "");
  if (!m) return null;
  return { ac: Number(m[1]), battery_flag: Number(m[2]), percent: Number(m[3]), system_status_flag: Number(m[4]) };
}

export interface PowerDecision { pause: boolean; reason: string }

/**
 * Pause on battery saver (always) and on battery power (pause_on_battery, default on). Unknown power never pauses: a
 * desktop or an unreadable state runs.
 */
export function powerDecision(p: PowerStatus | null, cfg: { pause_on_battery: boolean }): PowerDecision {
  if (!p) return { pause: false, reason: "power state unknown: running" };
  if ((p.system_status_flag & 1) === 1) return { pause: true, reason: "battery saver (energy saver) is on" };
  if (cfg.pause_on_battery && p.ac === 0) return { pause: true, reason: `on battery (${p.percent === 255 ? "?" : p.percent}%)` };
  return { pause: false, reason: p.ac === 1 ? "on mains power" : "power fine" };
}

// ---------------------------------------------------------------- the checkpoint

export type ScenarioStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface ScenarioState {
  status: ScenarioStatus;
  /** Finished tries that failed (a failure is run once more). */
  tries: number;
  /** Times the PC slept, shut down or the runner stopped in the middle of it (run again, not counted as a try). */
  interruptions: number;
  started?: string;
  ended?: string;
  step?: string;
  reason?: string;
}

export interface Finding {
  run: string;
  scenario: string;
  step: string;
  kind: "check" | "error" | "dialog" | "timeout" | "revit" | "setup";
  expected: string;
  got: string;
  at: string;
  /** The tries it happened on: one finding for the same failure on the first try and the retry. */
  tries: number[];
}

/** Adds a finding, or adds this try to the same finding (scenario, step, kind, expected, got) from an earlier try. */
export function addFinding(s: RunState, f: Omit<Finding, "tries">, attempt: number): RunState {
  const same = s.findings.find((x) => x.scenario === f.scenario && x.step === f.step && x.kind === f.kind && x.expected === f.expected && x.got === f.got);
  if (same) { if (!same.tries.includes(attempt)) same.tries.push(attempt); }
  else s.findings.push({ ...f, tries: [attempt] });
  return s;
}

export interface RunState {
  schema: string;
  run: string;
  created: string;
  updated: string;
  status: "running" | "paused" | "done";
  scenarios_dir: string;
  results_dir: string;
  order: string[];
  scenarios: Record<string, ScenarioState>;
  /** The Revit this run started (never anyone else's): pid, port and the process's start time, to know it again. */
  revit?: { pid: number; port: number; process_start: string; opened?: string };
  pauses: Array<{ from: string; to?: string; reason: string }>;
  gaps: Array<{ from: string; to: string; seconds: number }>;
  findings: Finding[];
  finished?: string;
}

export function runId(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `TR-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export function newRun(run: string, order: string[], dirs: { scenarios_dir: string; results_dir: string }, now: Date): RunState {
  const at = now.toISOString();
  const scenarios: Record<string, ScenarioState> = {};
  for (const id of order) scenarios[id] = { status: "pending", tries: 0, interruptions: 0 };
  return { schema: STATE_SCHEMA, run, created: at, updated: at, status: "running", ...dirs, order: [...order], scenarios, pauses: [], gaps: [], findings: [] };
}

/** The scenario to run next: the first not finished, in order (a running one was interrupted and runs again). */
export function nextScenario(s: RunState): string | null {
  return s.order.find((id) => s.scenarios[id]?.status === "pending" || s.scenarios[id]?.status === "running") ?? null;
}

export function startScenario(s: RunState, id: string, now: Date): RunState {
  const sc = s.scenarios[id];
  s.scenarios[id] = { ...sc, status: "running", started: now.toISOString(), step: undefined, reason: undefined };
  s.updated = now.toISOString();
  return s;
}

/** A scenario ended. A failure goes back to pending once (MAX_TRIES), so it runs again from its setup. */
export function finishScenario(s: RunState, id: string, outcome: "passed" | "failed" | "skipped", reason: string, now: Date): RunState {
  const sc = s.scenarios[id];
  const at = now.toISOString();
  if (outcome === "failed") {
    const tries = sc.tries + 1;
    s.scenarios[id] = tries < MAX_TRIES
      ? { ...sc, status: "pending", tries, step: undefined, reason: `failed on try ${tries}, runs once more: ${reason}` }
      : { ...sc, status: "failed", tries, ended: at, reason };
  } else s.scenarios[id] = { ...sc, status: outcome, ended: at, reason: reason || undefined };
  s.updated = at;
  return s;
}

/** The PC slept or the runner stopped mid-scenario: it runs again from its setup, up to MAX_INTERRUPTIONS times. */
export function interruptScenario(s: RunState, id: string, why: string, now: Date): RunState {
  const sc = s.scenarios[id];
  const n = sc.interruptions + 1;
  s.scenarios[id] = n > MAX_INTERRUPTIONS
    ? { ...sc, status: "failed", interruptions: n, ended: now.toISOString(), reason: `interrupted ${n} times (last: ${why})` }
    : { ...sc, status: "pending", interruptions: n, step: undefined, reason: `interrupted (${why}): runs again from its setup` };
  s.updated = now.toISOString();
  return s;
}

/**
 * A run picked up again after the runner stopped: a scenario left "running" was interrupted, and the time since the last
 * heartbeat is recorded as a gap (sleep or shutdown). Scenarios that passed stay passed.
 */
export function resumeRun(s: RunState, lastBeat: string | undefined, now: Date): RunState {
  const last = lastBeat ? Date.parse(lastBeat) : NaN;
  if (Number.isFinite(last) && now.getTime() - last > GAP_MS)
    s.gaps.push({ from: new Date(last).toISOString(), to: now.toISOString(), seconds: Math.round((now.getTime() - last) / 1000) });
  for (const id of s.order) if (s.scenarios[id]?.status === "running") interruptScenario(s, id, "the runner stopped (sleep, shutdown or closed)", now);
  const open = s.pauses[s.pauses.length - 1];
  if (open && !open.to) open.to = now.toISOString();
  s.status = "running";
  s.updated = now.toISOString();
  return s;
}

/** A gap in the clock while the runner was alive: the PC slept (timers stop, the clock doesn't). */
export function sleptBetween(prevTickMs: number, nowMs: number): boolean {
  return nowMs - prevTickMs > GAP_MS;
}

/** Whether another runner holds the run: its process is alive and its heartbeat fresh. */
export function lockVerdict(lock: { pid: number; beat: string } | null, alive: (pid: number) => boolean, now: Date, selfPid: number): "free" | "busy" | "stale" {
  if (!lock) return "free";
  if (lock.pid === selfPid) return "free";
  const fresh = now.getTime() - Date.parse(lock.beat) <= GAP_MS;
  return fresh && alive(lock.pid) ? "busy" : "stale";
}

/**
 * The scheduled task's start (auto): resume an unfinished run; else start a new one when the last finished longer ago
 * than newAfterHours (or there was none); else nothing to do.
 */
export function autoDecision(last: RunState | null, now: Date, newAfterHours: number): { action: "resume" | "new" | "nothing"; reason: string } {
  if (!last) return { action: "new", reason: "no run yet" };
  if (last.status !== "done") return { action: "resume", reason: `run ${last.run} isn't finished` };
  const ended = Date.parse(last.finished ?? last.updated);
  const hours = (now.getTime() - ended) / 3600000;
  if (hours >= newAfterHours) return { action: "new", reason: `the last run ended ${Math.round(hours)} h ago` };
  return { action: "nothing", reason: `run ${last.run} finished ${Math.round(hours * 10) / 10} h ago (a new one after ${newAfterHours} h)` };
}

export function counts(s: RunState) {
  const c = { passed: 0, failed: 0, skipped: 0, pending: 0, running: 0 };
  for (const id of s.order) c[s.scenarios[id]?.status ?? "pending"]++;
  return c;
}

/** Scenarios to skip before they start: an explicit skip, or an app it needs that isn't open. */
export function skipReason(sc: Pick<Scenario, "skip" | "needs">, running: (app: NeedsApp) => boolean): string {
  if (sc.skip) return sc.skip;
  const missing = (sc.needs ?? []).filter((a) => !running(a));
  return missing.length ? `needs ${missing.join(", ")}, which isn't open` : "";
}

/** The run's summary for a person: scenarios, findings (scenario, step, expected, got), pauses and gaps. */
export function summaryMarkdown(s: RunState, titles: Record<string, string> = {}): string {
  const c = counts(s);
  const out: string[] = [];
  out.push(`# Unattended Revit tests: ${s.run}`, "");
  out.push(`Started ${s.created}${s.finished ? `, finished ${s.finished}` : `, ${s.status}`}. ` +
    `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped${c.pending + c.running ? `, ${c.pending + c.running} to run` : ""}.`, "");
  out.push("| Scenario | Result | Tries | Note |", "|---|---|---|---|");
  for (const id of s.order) {
    const sc = s.scenarios[id];
    const note = (sc.reason ?? "").replace(/\|/g, "/").replace(/\r?\n/g, " ").slice(0, 200);
    out.push(`| ${id}${titles[id] ? ` (${titles[id]})` : ""} | ${sc.status} | ${sc.tries}${sc.interruptions ? ` (+${sc.interruptions} interrupted)` : ""} | ${note} |`);
  }
  out.push("", `## Findings (${s.findings.length})`, "");
  if (!s.findings.length) out.push("None.");
  else {
    out.push("| Scenario | Step | Kind | Expected | Got | Tries |", "|---|---|---|---|---|---|");
    const cell = (x: string) => x.replace(/\|/g, "/").replace(/\r?\n/g, " ").slice(0, 300);
    for (const f of s.findings) out.push(`| ${f.scenario} | ${cell(f.step)} | ${f.kind} | ${cell(f.expected)} | ${cell(f.got)} | ${f.tries.join(", ")} |`);
    out.push("", "Each finding is in findings.json, ready to be raised as a test-finding issue by a person or the AI (the runner never posts).");
  }
  if (s.pauses.length) {
    out.push("", "## Pauses", "");
    for (const p of s.pauses) out.push(`- ${p.from} to ${p.to ?? "now"}: ${p.reason}`);
  }
  if (s.gaps.length) {
    out.push("", "## Gaps (sleep, shutdown or the runner stopped)", "");
    for (const g of s.gaps) out.push(`- ${g.from} to ${g.to} (${Math.round(g.seconds / 60)} min): resumed from the checkpoint`);
  }
  return out.join("\n") + "\n";
}

/** Findings as issue drafts (title and body) for a person or the AI to raise; the runner never posts them. */
export function findingDrafts(s: RunState): Array<{ title: string; body: string }> {
  return s.findings.map((f) => ({
    title: `Unattended test ${f.scenario}: ${f.step} (${f.kind})`,
    body: [`Run ${f.run}, ${f.tries.length > 1 ? `tries ${f.tries.join(", ")}` : `try ${f.tries[0]}`}, first at ${f.at}.`, "", `Scenario: ${f.scenario}`, `Step: ${f.step}`, `Expected: ${f.expected}`, `Got: ${f.got}`].join("\n"),
  }));
}
