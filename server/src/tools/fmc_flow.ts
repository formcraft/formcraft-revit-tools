import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { BUILTIN_FLOWS, FLOW, Flow, runFlow } from "../hub/flows.js";
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
    "exchange packages (every hand-over between apps, with checksums), newest first; verify checks one is unchanged. " +
    "identity: the project's identity map (one Formcraft id per element, mapped to each app's id).";

export const FMC_FLOW_SHAPE = {
  action: z.enum(["list", "show", "run", "save", "packages", "verify", "identity"]),
  flow: z.string().optional().default("").describe("show, run: the flow's name; save: the new flow's name"),
  vars: z.record(z.string(), z.any()).optional().default({}).describe("run: the values the flow needs, e.g. { \"role\": \"A\" }"),
  steps: z.array(z.record(z.string(), z.any())).optional().describe("save: the steps, each { name, tool, args, real_only? }"),
  description: z.string().optional().default(""),
  needs: z.array(z.string()).optional().default([]),
  project_folder: z.string().optional().default("").describe("the project (its 01_WIP\\_Exchange); without one, <reports>\\Exchange"),
  package: z.string().optional().default("").describe("verify: the package id"),
  app: z.string().optional().default("").describe("packages: only those from or to this app"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcFlowArgs = z.infer<z.ZodObject<typeof FMC_FLOW_SHAPE>>;

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

export async function runFmcFlow(args: FmcFlowArgs) {
  const { config } = loadConfig();
  const root = exchangeRoot(args.project_folder ? expandEnv(args.project_folder) : undefined, expandEnv(config.reports_dir));
  try {
    if (args.action === "packages") {
      const p = listPackages(root, { app: args.app || undefined });
      return reply({ exchange: root, packages: p.length, newest: p.slice(0, 30).map((m) => ({ id: m.id, from: m.from, to: m.to, what: m.what, files: m.files.length, created: m.created })) });
    }
    if (args.action === "verify") {
      if (!args.package) return reply({ refused: true, reasons: ["Name the package (fmc_flow packages lists them)"] }, true);
      return reply({ package: args.package, ...verifyPackage(root, args.package) });
    }
    if (args.action === "identity") return reply({ exchange: root, ...identityStats(loadIdentity(root)) });

    const own = projectFlows(root);
    const all = [...BUILTIN_FLOWS, ...own.flows];
    if (args.action === "list")
      return reply({ exchange: root, flows: all.map((f) => ({ name: f.name, description: f.description, needs: f.needs, steps: f.steps.length,
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
