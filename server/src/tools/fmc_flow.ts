import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { BUILTIN_FLOWS, FLOW, Flow, runFlow } from "../hub/flows.js";
import { readInstances } from "../fmc/connect.js";
import { localIso } from "../fmc/jobs.js";
import { exchangeRoot, identityStats, listPackages, loadIdentity, verifyPackage } from "../hub/exchange.js";
import { recorded, startedByFrom } from "../fmc/ledger.js";

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

export const FMC_FLOW_DESCRIPTION =
  "Formcraft engineering hub, the exchange layer (docs/PLAN_ENGINEERING_HUB.md, X0). Saved flows are repeatable work " +
    "across apps as a file, run from a button, the command line or a schedule without AI. list: the flows (built in, and " +
    "the project's <project>\\01_WIP\\_Exchange\\Flows\\*.flow.json). show: one flow's steps. run: a flow, a dry run unless " +
    "dry_run is false (every step that has a dry run gets the run's value); vars give what the flow needs; a failing step " +
    "stops it and the run record says where. save: a project flow from steps (checked first). packages: the project's " +
    "exchange packages (every hand-over between apps, with checksums), newest first (the reply says N of M when more than 30 exist); verify checks one is unchanged. " +
    "list and packages honour document (or project_folder) to pick the project's 01_WIP\\_Exchange; without either they use the machine-wide default and say so. " +
    "identity: the project's identity map (one Formcraft id per element, mapped to each app's id). " +
    "runs: the run records (<exchange>\\Runs), newest first, with each run's result and where it stopped (flow narrows them); " +
    "runs with run set to a record's id shows that record in full. Read-only.";

export const FMC_FLOW_SHAPE = {
  action: z.enum(["list", "show", "run", "save", "packages", "verify", "identity", "runs"]),
  run: z.string().optional().default("").describe("runs: a run record's id (from runs) to show in full"),
  limit: z.number().int().min(1).max(200).optional().default(20).describe("runs: how many records"),
  flow: z.string().optional().default("").describe("show, run: the flow's name; save: the new flow's name"),
  vars: z.record(z.string(), z.any()).optional().default({}).describe("run: the values the flow needs, e.g. { \"role\": \"A\" }"),
  steps: z.array(z.record(z.string(), z.any())).optional().describe("save: the steps, each { name, tool, args, real_only? }"),
  description: z.string().optional().default(""),
  needs: z.array(z.string()).optional().default([]),
  project_folder: z.string().optional().default("").describe("the project (its 01_WIP\\_Exchange); without one, document is used if it is a path under 01_WIP, else <reports>\\Exchange"),
  document: z.string().optional().default("").describe("list, packages and the other file actions: the open model; its path (or a matching open document) selects the project's exchange when project_folder is empty"),
  package: z.string().optional().default("").describe("verify: the package id"),
  app: z.string().optional().default("").describe("packages: only those from or to this app"),
  dry_run: z.boolean().optional().default(true),
};

type FlowParsed = z.infer<z.ZodObject<typeof FMC_FLOW_SHAPE>>;
/** run, limit and document are optional for callers that build args by hand. */
export type FmcFlowArgs = Omit<FlowParsed, "run" | "limit" | "document"> & Partial<Pick<FlowParsed, "run" | "limit" | "document">>;

const RUN_ID = /^[A-Za-z0-9_-]{1,200}$/;

export type OpenDocRef = { title?: string; path?: string };

/** The project folder above 01_WIP, or empty when the path is not under a project. */
export function projectFolderFromPath(document: string): string {
  const norm = document.replace(/\//g, "\\").trim();
  if (!norm) return "";
  const at = norm.toLowerCase().indexOf("\\01_wip\\");
  if (at > 0) return norm.slice(0, at);
  if (norm.toLowerCase().endsWith("\\01_wip")) return norm.slice(0, norm.lastIndexOf("\\"));
  return "";
}

/**
 * Which exchange root list and packages (and the other file actions) should read. project_folder wins; otherwise
 * document, if it is a path under 01_WIP or matches an open model's path (Tool Research P-fmc_flow-01).
 */
export function resolveFlowRoot(opts: {
  project_folder?: string;
  document?: string;
  reportsDir: string;
  openDocs?: OpenDocRef[];
}): { root: string; project_folder: string; scope: "project" | "machine-wide default"; notes: string[] } {
  const notes: string[] = [];
  const explicit = (opts.project_folder ?? "").trim();
  const document = (opts.document ?? "").trim();
  let folder = "";
  if (explicit) folder = explicit;
  else {
    folder = projectFolderFromPath(document);
    if (!folder && document) {
      const q = document.replace(/\//g, "\\").toLowerCase();
      const hit = (opts.openDocs ?? []).find((d) => {
        const t = (d.title ?? "").toLowerCase();
        const p = (d.path ?? "").replace(/\//g, "\\").toLowerCase();
        return t === q || p === q || p.endsWith("\\" + q);
      });
      if (hit?.path) folder = projectFolderFromPath(hit.path);
    }
    if (!folder && document) {
      notes.push(`document "${document}" did not resolve to a project folder (pass project_folder, or a document path under 01_WIP): project flows were not searched; this is the machine-wide default exchange.`);
    }
  }
  if (!folder && !notes.length) notes.push("No project_folder: list and packages used the machine-wide default exchange; project flows were not searched.");
  return { root: exchangeRoot(folder || undefined, opts.reportsDir), project_folder: folder, scope: folder ? "project" : "machine-wide default", notes };
}

/** The run records in <exchange>\Runs, newest first (Tool Research, fmc_flow: they were written but could not be listed). */
export function listRuns(root: string, opts: { flow?: string; limit?: number } = {}): { runs: Array<Record<string, unknown>>; total: number; dir: string } {
  const dir = win.join(root, "Runs");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return { runs: [], total: 0, dir }; }
  const rows: Array<Record<string, unknown>> = [];
  for (const file of files) {
    let rec: any = null;
    try { rec = JSON.parse(fs.readFileSync(win.join(dir, file), "utf8").replace(/^\uFEFF/, "")); } catch { /* a torn record is listed by name */ }
    const name = String(rec?.flow ?? "");
    if (opts.flow && name !== opts.flow && !file.includes(`_${opts.flow}`)) continue;
    rows.push({
      id: file.replace(/\.json$/, ""), flow: name || null, dry_run: rec?.dry_run ?? /_dry\.json$/.test(file),
      ok: rec?.ok ?? null, started: rec?.started ?? null, ended: rec?.ended ?? null,
      ...(rec?.stopped_at ? { stopped_at: rec.stopped_at } : {}),
      steps: Array.isArray(rec?.steps) ? rec.steps.length : null,
      ...(rec ? {} : { problem: "the record could not be read" }),
    });
  }
  rows.sort((a, b) => String(b.started ?? b.id).localeCompare(String(a.started ?? a.id)));
  return { runs: rows.slice(0, opts.limit ?? 20), total: rows.length, dir };
}

/** One run record in full (cut at 30,000 characters), or null when there is none by that id. */
export function readRun(root: string, id: string): { record: unknown; truncated: boolean; file: string } | null {
  if (!RUN_ID.test(id)) return null;
  const file = win.join(root, "Runs", `${id}.json`);
  let text = "";
  try { text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); } catch { return null; }
  if (text.length > 30000) return { record: text.slice(0, 30000), truncated: true, file };
  try { return { record: JSON.parse(text), truncated: false, file }; } catch { return { record: text, truncated: false, file }; }
}

/** The project's flows (<exchange>\Flows\*.flow.json) and their problems. */
function projectFlows(root: string): { flows: Flow[]; problems: string[] } {
  const dir = win.join(root, "Flows");
  const flows: Flow[] = [], problems: string[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".flow.json")); } catch { return { flows, problems }; }
  for (const f of files) {
    try { flows.push(FLOW.parse(JSON.parse(fs.readFileSync(win.join(dir, f), "utf8").replace(/^﻿/, "")))); }
    catch (e) { problems.push(`${f}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`); }
  }
  return { flows, problems };
}

/** A Formcraft tool run by name, through the same arguments and defaults as the MCP tool (tools/<tool>.ts). */
export async function callTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; body: any }> {
  if (!/^fmc_[a-z_]+$/.test(tool)) throw new Error(`Not a Formcraft tool: ${tool}`);
  const mod: Record<string, any> = await import(`./${tool}.js`);
  const shape = Object.entries(mod).find(([k]) => /^FMC_[A-Z_]+_SHAPE$/.test(k))?.[1];
  const run = Object.entries(mod).find(([k, v]) => /^runFmc/.test(k) && typeof v === "function")?.[1];
  if (!shape || !run) throw new Error(`${tool} can't run in a flow (no argument shape or run function)`);
  // F74: a step is a call started by a job (by the schedule when a scheduled task runs the flow), in the call ledger
  const by = startedByFrom(process.env, "ai") === "schedule" ? "schedule" : "job";
  const r = await recorded(tool, args, by, () => run(z.object(shape).parse(args)));
  let body: any = {};
  try { body = JSON.parse(r?.content?.[0]?.text ?? "{}"); } catch { body = { text: r?.content?.[0]?.text }; }
  return { ok: !r?.isError, body };
}

async function acceptsDryRun(tool: string): Promise<boolean> {
  try {
    const mod: Record<string, any> = await import(`./${tool}.js`);
    const shape = Object.entries(mod).find(([k]) => /^FMC_[A-Z_]+_SHAPE$/.test(k))?.[1];
    return !!shape && "dry_run" in shape;
  } catch { return false; }
}

export type FlowDeps = { openDocs?: OpenDocRef[]; reportsDir?: string };

export async function runFmcFlow(args: FmcFlowArgs, deps: FlowDeps = {}) {
  const { config } = loadConfig();
  const reportsDir = deps.reportsDir ?? expandEnv(config.reports_dir);
  const openDocs = deps.openDocs ?? readInstances().flatMap((i) => i.documents.map((d) => ({ title: d.title, path: d.path })));
  const resolved = resolveFlowRoot({ project_folder: args.project_folder ? expandEnv(args.project_folder) : "", document: args.document, reportsDir, openDocs });
  const root = resolved.root;
  const scope = { exchange: root, scope: resolved.scope, ...(resolved.project_folder ? { project_folder: resolved.project_folder } : {}), ...(resolved.notes.length ? { notes: resolved.notes } : {}) };
  try {
    if (args.action === "packages") {
      const p = listPackages(root, { app: args.app || undefined });
      const shown = Math.min(p.length, 30);
      return reply({
        ...scope,
        packages: p.length,
        shown,
        ...(p.length > shown ? { truncated: true, note: `${shown} of ${p.length}` } : {}),
        newest: p.slice(0, 30).map((m) => ({ id: m.id, from: m.from, to: m.to, what: m.what, files: m.files.length, created: m.created, created_local: localIso(m.created) })),
      });
    }
    if (args.action === "verify") {
      if (!args.package) return reply({ refused: true, reasons: ["Name the package (fmc_flow packages lists them)"] }, true);
      return reply({ package: args.package, ...verifyPackage(root, args.package) });
    }
    if (args.action === "identity") return reply({ exchange: root, ...identityStats(loadIdentity(root)) });
    if (args.action === "runs") {
      const id = (args.run ?? "").trim();
      if (id) {
        const one = readRun(root, id);
        if (!one) return reply({ refused: true, reasons: [`No run record "${id}" in ${win.join(root, "Runs")} (fmc_flow runs lists them)`] }, true);
        return reply({ exchange: root, run: id, file: one.file, ...(one.truncated ? { truncated: true } : {}), record: one.record });
      }
      return reply({ exchange: root, ...listRuns(root, { flow: args.flow || undefined, limit: args.limit ?? 20 }), read_only: true });
    }

    const own = projectFlows(root);
    const all = [...BUILTIN_FLOWS, ...own.flows];
    if (args.action === "list")
      return reply({ ...scope, flows: all.map((f) => ({ name: f.name, description: f.description, needs: f.needs, steps: f.steps.length,
        from: BUILTIN_FLOWS.includes(f) ? "built in" : "project" })), problems: own.problems });

    if (args.action === "save") {
      const flow = FLOW.safeParse({ name: args.flow, description: args.description, needs: args.needs, steps: args.steps ?? [] });
      if (!flow.success) return reply({ refused: true, reasons: flow.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, true);
      if (BUILTIN_FLOWS.some((f) => f.name === flow.data.name)) return reply({ refused: true, reasons: [`${flow.data.name} is a built-in flow: choose another name`] }, true);
      const file = win.join(root, "Flows", `${flow.data.name}.flow.json`);
      const where = checkWritePath(file, config, { checkName: false });
      if (!where.ok) return reply({ refused: true, reasons: where.reasons }, true);
      if (args.dry_run) return reply({ dry_run: true, would_save: file, flow: flow.data, next: "Run again with dry_run=false to save it" });
      fs.mkdirSync(win.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        const archive = win.join(root, "Flows", "_Archive");
        fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(file, win.join(archive, `${flow.data.name}_${Date.now()}.flow.json`));
      }
      fs.writeFileSync(file, JSON.stringify(flow.data, null, 2));
      log(config, "flow_save", false, file, "saved", `${flow.data.steps.length} steps`);
      return reply({ saved: file, next: `fmc_flow run flow=${flow.data.name} (a dry run first)` });
    }

    const flow = all.find((f) => f.name === args.flow);
    if (!flow) return reply({ refused: true, reasons: [`No flow named "${args.flow}" (fmc_flow list shows them)`] }, true);
    if (args.action === "show") return reply({ flow });

    // run
    const dry = args.dry_run !== false;
    const flags = new Map<string, boolean>();
    for (const s of flow.steps) flags.set(s.tool, await acceptsDryRun(s.tool));
    const run = await runFlow(flow, { dryRun: dry, vars: args.vars, call: callTool, acceptsDryRun: (t) => flags.get(t) ?? false });
    // the run record: what each step did, beside the exchange (a flow run is itself traceable)
    try {
      const dir = win.join(root, "Runs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(win.join(dir, `${run.started.replace(/[:.]/g, "-")}_${flow.name}${dry ? "_dry" : ""}.json`), JSON.stringify(run, null, 2));
    } catch { /* the answer still comes back */ }
    log(config, "flow_run", dry, flow.name, run.ok ? "ok" : `stopped at ${run.stopped_at}`, `${run.steps.length} steps`);
    return reply({ ...run, steps: run.steps.map((s) => ({ ...s, body: summarise(s.body) })),
      next: run.ok ? (dry ? `Run again with dry_run=false to do it` : "Done") : `Stopped at ${run.stopped_at}: fix it and run the flow again` }, !run.ok);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "flow_" + args.action, args.dry_run !== false, args.flow || root, "error", msg);
    return reply({ error: msg }, true);
  }
}

/** A step's answer, cut down so a long flow's reply stays readable (the run record keeps everything). */
function summarise(body: any): any {
  if (!body || typeof body !== "object") return body;
  const text = JSON.stringify(body);
  if (text.length <= 1500) return body;
  const keep: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v !== "object" || v === null) keep[k] = v;
  return { ...keep, note: "cut: the full answer is in the run record (<exchange>\\Runs)" };
}

export function registerFmcFlowTool(server: McpServer) {
  server.tool("fmc_flow", FMC_FLOW_DESCRIPTION, FMC_FLOW_SHAPE, (args) => runFmcFlow(args));
}
