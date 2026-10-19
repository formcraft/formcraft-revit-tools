import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Saved add-ons (KISIC_GAP_SCRIPTS.md §4.2, docs/ADDONS.md): C# bodies in resources/addons/, versioned and CI-checked in
 * this repo, shipped with the server (build/addons), run through the send_code bridge with no AI writing code.
 *
 *   // @addon strips_on_room_walls  @version 1.0  @writes model  @dryrun yes
 *   // @does  one line: what it does
 *   // @params {"room":"06","height_mm":2850}     every parameter with its default (the default gives its type)
 *   // @required rooms,type                       parameters a run must give (their @params value is only an example)
 *   // @paths out_dir                             parameters that are folders it writes to (checked like any write)
 *   // @returns {"placed":n,...}
 *   // @usings System.IO, Newtonsoft.Json.Linq
 *
 * The body gets parameters[0] = the JSON object, parameters[1] = "dry" | "real", and makes model changes only through
 * FmcScript.Tx (a dry run rolls back). Pure functions here: header, parameters, the call and the job runner; the tool
 * (tools/fmc_scripts.ts) does the files, the guard and Revit.
 */

export interface AddonHeader {
  name: string;
  version: string;
  writes: "model" | "none";
  dryrun: boolean;
  does: string;
  /** Every parameter with its default; the default's JSON type is the parameter's type (null: any). */
  params: Record<string, unknown>;
  required: string[];
  /** Parameters that name folders the add-on writes files to. */
  paths: string[];
  returns: string;
  usings: string[];
  file: string;
}

const NAME = /^[a-z][a-z0-9_]{1,62}$/;
const NO_SPLIT = new Set(["params", "returns", "does"]);

/** The leading // comment block of a body, without the slashes. */
function headerLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("//")) break;
    out.push(line.replace(/^\/\/\s?/, ""));
  }
  return out;
}

/** Reads an add-on's header. problems is empty when the add-on can be listed and run. */
export function parseAddonHeader(text: string, file = ""): { addon?: AddonHeader; problems: string[] } {
  const problems: string[] = [];
  const tags = new Map<string, string>();
  const lines = headerLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("@")) continue;
    const first = /^@([a-z]+)/.exec(line)?.[1] ?? "";
    // "@addon x  @version 1.0  @writes model" holds several tags; @params, @returns and @does hold one value each.
    const parts = NO_SPLIT.has(first) ? [line] : line.split(/\s+(?=@[a-z]+\b)/);
    for (const part of parts) {
      const m = /^@([a-z]+)\s*(.*)$/s.exec(part.trim());
      if (!m) continue;
      let value = m[2].trim();
      // @params may run on over the next comment lines until its JSON is whole
      if (m[1] === "params") {
        let j = i;
        while (!parses(value) && j + 1 < lines.length && !lines[j + 1].trim().startsWith("@")) value += " " + lines[++j].trim();
        i = j;
      }
      if (tags.has(m[1])) problems.push(`@${m[1]} appears twice`);
      tags.set(m[1], value);
    }
  }
  const name = tags.get("addon") ?? "";
  if (!name) return { problems: ["No // @addon <name> header"] };
  if (!NAME.test(name)) problems.push(`@addon ${name}: names are lower case letters, digits and _`);
  const base = file ? path.basename(file).replace(/\.cs$/i, "") : name;
  if (file && base !== name) problems.push(`@addon ${name} is in ${path.basename(file)}: the file must be ${name}.cs`);
  const version = tags.get("version") ?? "";
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) problems.push(`@version "${version}" is not a version like 1.0`);
  const writes = tags.get("writes") ?? "";
  if (writes !== "model" && writes !== "none") problems.push(`@writes is model or none, not "${writes}"`);
  const dryrunTag = tags.get("dryrun") ?? "";
  if (dryrunTag !== "yes" && dryrunTag !== "no") problems.push(`@dryrun is yes or no, not "${dryrunTag}"`);
  if (writes === "model" && dryrunTag !== "yes") problems.push("An add-on that writes the model must support a dry run (@dryrun yes)");
  let params: Record<string, unknown> = {};
  const rawParams = tags.get("params") ?? "{}";
  try {
    const parsed = JSON.parse(rawParams);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) problems.push("@params is not a JSON object");
    else params = parsed;
  } catch (e) {
    problems.push(`@params is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = (tag: string) => (tags.get(tag) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const required = list("required");
  const paths = list("paths");
  for (const k of [...required, ...paths]) if (!(k in params)) problems.push(`${k} is in @required or @paths but not in @params`);
  const usings = list("usings");
  if (!/FmcScript\.Params\(parameters\)/.test(text)) problems.push("The body doesn't read its parameters with FmcScript.Params(parameters)");
  if (writes === "model" && !/FmcScript\.Tx\(/.test(text)) problems.push("An add-on that writes the model makes its changes in FmcScript.Tx");
  return {
    addon: { name, version, writes: writes === "model" ? "model" : "none", dryrun: dryrunTag === "yes", does: tags.get("does") ?? "",
      params, required, paths, returns: tags.get("returns") ?? "", usings, file },
    problems,
  };
}

function parses(json: string): boolean {
  try { JSON.parse(json); return true; } catch { return false; }
}

type Kind = "string" | "number" | "boolean" | "array" | "object" | "null";
const kindOf = (v: unknown): Kind => (v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as Kind));
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) ||
  (kindOf(v) === "object" && Object.keys(v as object).length === 0);

/**
 * A run's parameters against the header: unknown names and wrong types are refused, required ones must be given (not
 * empty), the rest take their default. Accepts an object or its JSON text.
 */
export function validateAddonParams(addon: AddonHeader, input: unknown): { ok: boolean; params: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  let given: unknown = input ?? {};
  if (typeof given === "string") {
    try { given = given.trim() ? JSON.parse(given) : {}; } catch (e) {
      return { ok: false, params: {}, problems: [`params is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  if (kindOf(given) !== "object") return { ok: false, params: {}, problems: ["params is a JSON object"] };
  const g = given as Record<string, unknown>;
  for (const k of Object.keys(g)) {
    if (!(k in addon.params)) { problems.push(`${addon.name} has no parameter "${k}" (it has ${Object.keys(addon.params).join(", ") || "none"})`); continue; }
    const want = kindOf(addon.params[k]);
    const got = kindOf(g[k]);
    if (want !== "null" && got !== want && got !== "null") problems.push(`${k} is ${want === "array" ? "a list" : want === "object" ? "an object" : `a ${want}`}, not ${got === "array" ? "a list" : got}`);
  }
  for (const k of addon.required) if (empty(g[k])) problems.push(`${k} is required`);
  const params: Record<string, unknown> = {};
  for (const k of Object.keys(addon.params)) params[k] = g[k] !== undefined && g[k] !== null ? g[k] : addon.params[k];
  return { ok: problems.length === 0, params, problems };
}

/** What send_code_to_revit gets for a run: the whole file as the body (so error lines are the file's lines). */
export function addonCall(addon: AddonHeader, code: string, params: Record<string, unknown>, dryRun: boolean) {
  return { code: code.replace(/^﻿/, ""), parameters: [JSON.stringify(params), dryRun ? "dry" : "real"], usings: addon.usings, transactionMode: "none" as const };
}

/** The add-ons folder: FMC_ADDONS_DIR, else build/addons beside this build (staged with the server), else the repo's resources/addons. */
export function addonDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = (env.FMC_ADDONS_DIR ?? "").trim();
  if (own) return own;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const built = path.resolve(here, "..", "addons");
  if (fs.existsSync(built)) return built;
  return path.resolve(here, "..", "..", "..", "resources", "addons");
}

export interface AddonFile { addon?: AddonHeader; code: string; problems: string[]; file: string }

export function readAddons(dir: string): AddonFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.cs$/i.test(n)).sort(); } catch { return []; }
  return names.map((n) => {
    const file = path.join(dir, n);
    const code = fs.readFileSync(file, "utf8");
    return { ...parseAddonHeader(code, file), code, file };
  });
}

// ------------------------------------------------------------------ jobs

export interface JobStep { addon: string; params: Record<string, unknown> }
export interface Job { name: string; dry_run: boolean; document: string; results_dir: string; steps: JobStep[] }

/**
 * A job file: {"name": "kisic_relight", "dry_run": false, "document": "", "results_dir": "", "steps": [{"addon": "qa_orphans",
 * "params": {...}}, ...]}. A list alone is read as the steps. dry_run defaults to true: a person writes false to say yes.
 */
export function parseJob(input: unknown): { job?: Job; problems: string[] } {
  const problems: string[] = [];
  const raw: any = Array.isArray(input) ? { steps: input } : input;
  if (!raw || typeof raw !== "object") return { problems: ["A job is a JSON object with steps, or a list of steps"] };
  const name = String(raw.name ?? "job").trim().replace(/[^A-Za-z0-9_-]+/g, "_") || "job";
  if (raw.dry_run !== undefined && typeof raw.dry_run !== "boolean") problems.push("dry_run is true or false");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) problems.push("A job needs at least one step");
  const steps: JobStep[] = [];
  (Array.isArray(raw.steps) ? raw.steps : []).forEach((s: any, i: number) => {
    if (!s || typeof s !== "object" || typeof s.addon !== "string" || !s.addon.trim()) { problems.push(`Step ${i + 1} has no addon`); return; }
    const p = s.params ?? {};
    if (kindOf(p) !== "object") { problems.push(`Step ${i + 1} (${s.addon}): params is a JSON object`); return; }
    steps.push({ addon: s.addon.trim(), params: p });
  });
  if (problems.length) return { problems };
  return { job: { name, dry_run: raw.dry_run !== false, document: String(raw.document ?? ""), results_dir: String(raw.results_dir ?? ""), steps }, problems };
}

export interface StepOutcome { ok: boolean; result?: unknown; error?: string; job?: string; ms?: number }
export type AddonRunner = (addon: AddonHeader, params: Record<string, unknown>, dryRun: boolean) => Promise<StepOutcome>;

export interface JobResult {
  job: string;
  dry_run: boolean;
  started: string;
  finished: string;
  done: boolean;
  stopped_at: string | null;
  steps: Array<{ step: number; addon: string; version: string; ok: boolean; ms: number; result?: unknown; error?: string; job?: string }>;
  skipped: string[];
}

/** Every step checked before any runs: a job with an unknown add-on or bad parameters is refused whole. */
export function checkJob(job: Job, addons: Map<string, AddonHeader>): { ok: boolean; problems: string[]; params: Record<string, unknown>[] } {
  const problems: string[] = [];
  const params: Record<string, unknown>[] = [];
  job.steps.forEach((s, i) => {
    const a = addons.get(s.addon);
    if (!a) { problems.push(`Step ${i + 1}: no add-on ${s.addon} (have ${[...addons.keys()].join(", ") || "none"})`); params.push({}); return; }
    const v = validateAddonParams(a, s.params);
    problems.push(...v.problems.map((p) => `Step ${i + 1} (${s.addon}): ${p}`));
    params.push(v.params);
  });
  return { ok: problems.length === 0, problems, params };
}

/** Runs the steps in order and stops at the first failure. The runner does the Revit call; tests pass a stand-in. */
export async function runJob(job: Job, addons: Map<string, AddonHeader>, runner: AddonRunner, now: () => Date = () => new Date()): Promise<JobResult> {
  const started = now().toISOString();
  const checked = checkJob(job, addons);
  if (!checked.ok) throw new Error(checked.problems.join("; "));
  const steps: JobResult["steps"] = [];
  for (let i = 0; i < job.steps.length; i++) {
    const a = addons.get(job.steps[i].addon)!;
    const t0 = now().getTime();
    let out: StepOutcome;
    try { out = await runner(a, checked.params[i], job.dry_run); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    steps.push({ step: i + 1, addon: a.name, version: a.version, ok: out.ok, ms: out.ms ?? Math.max(0, now().getTime() - t0),
      result: out.result, error: out.error, job: out.job });
    if (!out.ok) break;
  }
  const failed = steps.find((s) => !s.ok);
  return { job: job.name, dry_run: job.dry_run, started, finished: now().toISOString(), done: !failed,
    stopped_at: failed ? `step ${failed.step} (${failed.addon})` : null, steps,
    skipped: job.steps.slice(steps.length).map((s, k) => `step ${steps.length + k + 1} (${s.addon})`) };
}

/** results\<job>_<yyyy-mm-dd_HHMMSS>.json, in local time. */
export function jobResultFile(dir: string, job: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return path.join(dir, `${job}_${stamp}.json`);
}

/** An automation step "addon:<name>": the add-on's name, else null. */
export function addonStep(step: string): string | null {
  const m = /^addon:([a-z][a-z0-9_]*)$/.exec(step.trim());
  return m ? m[1] : null;
}

/** One line about an add-on's answer, for the automation's results. */
export function addonSummary(result: unknown): string {
  if (!result || typeof result !== "object") return result === undefined ? "done" : String(result).slice(0, 160);
  const r = result as Record<string, unknown>;
  const bits = Object.entries(r)
    .filter(([, v]) => typeof v === "number" || typeof v === "boolean" || (Array.isArray(v) && v.length > 0))
    .slice(0, 6)
    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : v}`);
  return bits.join(", ") || "done";
}
