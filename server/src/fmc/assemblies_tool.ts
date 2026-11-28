/**
 * fmc_assemblies (F59): the kit's patterns, curtain wall types, railing types and their legend. Every call has a
 * run id (in the reply and the file log). check and pat need no Revit; read is read only; plan reads and compares;
 * apply carries the plan out in one Undo (the dry run is the real run rolled back, through the read path; the real
 * run needs confirm=true and goes through the live-model lock); legend gives the fmc_legend calls.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, checkWritePath, csvLine, expandEnv } from "./policy.js";
import { AssembliesSpec, KIT_REQUEST, PatternTarget, checkSpec, kitAssembliesFile } from "./assemblies_spec.js";
import { patName, patText } from "./assemblies_pat.js";
import { ModelRead, applyPayload, legendPlan, planOps } from "./assemblies_plan.js";
import type { FmcAssembliesArgs } from "./assemblies_shape.js";

export type RevitSend = (command: string, payload: object, dry: boolean, ms: number) => Promise<unknown>;
export interface AssembliesIo { config?: { config: GuardConfig; problem: string }; revit?: RevitSend }
type Reply = { content: Array<{ type: "text"; text: string }>; isError: boolean };

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `AS-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${crypto.randomBytes(3).toString("hex")}`;
}

export function log(cfg: GuardConfig, dry: boolean, target: string, result: string, detail: string, action: string, runId: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dry, target, result, `run ${runId}: ${detail}`]));
  } catch { /* logging never blocks the work */ }
}

function readJson(file: string): unknown | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return null; }
}

/** The designs: the call's spec, else the kit file; checked. */
export function loadSpec(args: FmcAssembliesArgs, cfg: GuardConfig): { spec: AssembliesSpec; from: string; hash: string } | { refused: object } {
  const file = kitAssembliesFile(expandEnv(cfg.materials_file));
  const raw = args.spec ?? readJson(file);
  if (!raw) return { refused: { refused: true, reasons: ["The assembly designs are design inputs and the kit has none; nothing is defaulted"], kit_file: `none at ${file}`, kit_requests: [KIT_REQUEST] } };
  const chk = checkSpec(raw);
  if (!chk.spec) return { refused: { refused: true, reasons: ["The designs have problems; fix them first", ...chk.problems], from: args.spec ? "the call" : file } };
  const hash = crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 12);
  let spec = chk.spec;
  if (args.only?.length) {
    const want = new Set(args.only.map((n) => n.toLowerCase()));
    spec = { ...spec, patterns: spec.patterns.filter((p) => want.has(p.name.toLowerCase())), curtain_walls: spec.curtain_walls.filter((c) => want.has(c.name.toLowerCase())), railings: spec.railings.filter((r) => want.has(r.name.toLowerCase())) };
  }
  return { spec, from: args.spec ? "the call" : file, hash };
}

const confirmProblem = (args: FmcAssembliesArgs, dry: boolean, what: string) =>
  !dry && !args.confirm ? `dry_run=false ${what}: show the person the dry run first, then call again with confirm=true` : null;

function fileAction(target: string, content: string): string {
  if (!fs.existsSync(target)) return "new";
  return fs.readFileSync(target).equals(Buffer.from(content, "utf8")) ? "unchanged" : "replace (the old one moves to _Archive)";
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface Ctx { args: FmcAssembliesArgs; config: GuardConfig; problem: string; dry: boolean; run_id: string; send: RevitSend; reply: (b: object, e?: boolean) => Reply }

/** pat: the patterns as .pat files in <project>\01_WIP\_Assemblies (write roots only); dry run first. */
export function patAction(ctx: Ctx, spec: AssembliesSpec): Reply {
  const { args, config, problem, dry, run_id, reply } = ctx;
  const reasons: string[] = [];
  if (!args.project_folder.trim()) reasons.push("The .pat files go into the project's 01_WIP\\_Assemblies: set project_folder");
  if (!spec.patterns.length) reasons.push("The designs have no patterns");
  if (problem && !dry) reasons.push(problem);
  const c = confirmProblem(args, dry, "writes the .pat files");
  if (c) reasons.push(c);
  if (reasons.length) return reply({ refused: true, reasons }, true);
  const folder = path.join(args.project_folder.trim(), "01_WIP", "_Assemblies");
  const targets = (["drafting", "model"] as PatternTarget[]).filter((t) => spec.patterns.some((p) => p.target === t));
  const files = targets.map((t) => ({ name: patName(t), content: patText(spec.patterns, t), patterns: spec.patterns.filter((p) => p.target === t).length }));
  for (const target of [...files.map((f) => path.join(folder, f.name)), path.join(folder, "_Archive", "x.pat")]) {
    const v = checkWritePath(target, config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
  }
  const plan = files.map((f) => ({ file: f.name, patterns: f.patterns, action: fileAction(path.join(folder, f.name), f.content) }));
  log(config, dry, folder, dry ? "dry run" : "done", plan.map((p) => `${p.file} ${p.action}`).join("; "), "assemblies_pat", run_id);
  if (dry) return reply({ dry_run: true, folder, files: plan, next: "Show the person; then dry_run=false with confirm=true writes them" });
  fs.mkdirSync(folder, { recursive: true });
  const st = stamp();
  for (const f of files) {
    const target = path.join(folder, f.name);
    const step = plan.find((x) => x.file === f.name)!;
    if (step.action === "unchanged") continue;
    if (step.action !== "new") {
      fs.mkdirSync(path.join(folder, "_Archive"), { recursive: true });
      fs.renameSync(target, path.join(folder, "_Archive", f.name.replace(/\.pat$/, `_${st}.pat`)));
    }
    fs.writeFileSync(target, f.content, "utf8");
  }
  return reply({ dry_run: false, folder, files: plan, next: "Revit: Manage › Additional Settings › Fill Patterns › New › Custom › Import, or apply makes them in the model" });
}

export async function readModel(send: RevitSend): Promise<ModelRead> {
  return await send("fmc_assemblies_read", {}, true, 120000) as ModelRead;
}

/** apply: create and update what the plan says, one Undo; blocked items are skipped and listed. */
export async function applyAction(ctx: Ctx, spec: AssembliesSpec, read: ModelRead): Promise<Reply> {
  const { args, config, problem, dry, run_id, send, reply } = ctx;
  const plan = planOps(spec, read);
  const reasons: string[] = [];
  if (problem && !dry) reasons.push(problem);
  const c = confirmProblem(args, dry, "changes the model's patterns and types");
  if (c) reasons.push(c);
  if (reasons.length) return reply({ refused: true, reasons, ...plan }, true);
  const payload = applyPayload(plan.ops, dry);
  const n = payload.patterns.length + payload.curtain_walls.length + payload.railings.length;
  if (!n) return reply({ dry_run: dry, nothing_to_do: true, ...plan, next: plan.counts.blocked ? "The blocked items need the kit requests first" : "The model already matches the designs" });
  const result = await send("fmc_assemblies_apply", payload, dry, 300000) as { results?: unknown[]; rolled_back?: boolean; errors?: string[] };
  log(config, dry, "model", dry ? "dry run" : (result?.rolled_back ? "rolled back" : "done"), `${n} item(s): ${plan.counts.create} new, ${plan.counts.update} changed, ${plan.counts.blocked} blocked`, "assemblies_apply", run_id);
  return reply({ dry_run: dry, ...plan, result,
    next: dry ? "Show the person the plan and the dry run's result; then dry_run=false with confirm=true (one Undo)" : "Check the types in the model; Undo puts them back" });
}

export function legendAction(ctx: Ctx, spec: AssembliesSpec, read: ModelRead): Reply {
  const l = legendPlan(spec, read);
  if ("problem" in l) return ctx.reply({ refused: true, reasons: [l.problem] }, true);
  return ctx.reply({ legend: l, next: "Run the fmc_legend calls as given (each is a dry run first); apply the curtain wall types before placing them" });
}
