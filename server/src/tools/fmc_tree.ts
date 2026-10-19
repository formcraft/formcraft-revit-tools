import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { BuiltState, TREE, Tree, findNode, planTree, recordBuilt, resolve, treeProblems } from "../tree/tree.js";
import { ICU_BAY_SAMPLE } from "../tree/samples.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch { /* logging never blocks the work */ }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_TREE_DESCRIPTION =
  "Formcraft recipe tree (docs/PLAN_RECIPE_TREE.md, T0): the building as one recipe made of smaller recipes, kept in " +
    "<project>\\01_WIP\\_Tree\\FMC_Recipe_Tree.json. Nodes (project, building, level, department, room, assembly, system, " +
    "family, component) have inputs, inherited by their children (${var.width} in a tool's arguments), and are made by " +
    "Formcraft tools (fmc_ceiling, fmc_casework, fmc_recipe…). show: the outline. check: duplicate ids, unknown tools, " +
    "missing values. plan: every node against the last build (new, changed, unchanged); with run_tools, each changed node's " +
    "tool runs as a dry run and says what it would make. set: a node's inputs (a dry run first; the old tree is archived). " +
    "init: a sample tree (an ICU bay) when the project has none. build (T1): runs every changed node's tool for real, in tree " +
    "order (a dry run first lists them), stops at the first failure, and records what was built. built: records a build " +
    "made outside the tree (revisions), so the next " +
    "plan lists only what changed. It never changes a model by itself.";

export const FMC_TREE_SHAPE = {
  action: z.enum(["show", "check", "plan", "set", "init", "built", "build"]),
  project_folder: z.string().describe("The project folder (the tree lives in its 01_WIP)"),
  id: z.string().optional().default("").describe("set: the node; plan: only this node and what is under it"),
  inputs: z.record(z.string(), z.unknown()).optional().default({}).describe("set: inputs to change, e.g. { \"width\": 4500 }"),
  ids: z.array(z.string()).optional().default([]).describe("built: the nodes the build made"),
  run_tools: z.boolean().optional().default(false).describe("plan: also run each changed node's tool as a dry run (no model changes)"),
  dry_run: z.boolean().optional().default(true),
};
export type FmcTreeArgs = z.infer<z.ZodObject<typeof FMC_TREE_SHAPE>>;

export const treeFile = (project: string) => win.join(project, "01_WIP", "_Tree", "FMC_Recipe_Tree.json");
const stateFile = (project: string) => win.join(project, "01_WIP", "_Tree", "FMC_Recipe_Tree.state.json");

const toolExists = (tool: string) => fs.existsSync(new URL(`./${tool}.js`, import.meta.url));

async function dryRunTool(tool: string, args: Record<string, unknown>, real = false, ctx: { project?: string; node?: string } = {}): Promise<unknown> {
  const mod: Record<string, any> = await import(`./${tool}.js`);
  const shape = Object.entries(mod).find(([k]) => /^FMC_[A-Z_]+_SHAPE$/.test(k))?.[1];
  const run = Object.entries(mod).find(([k, v]) => /^runFmc/.test(k) && typeof v === "function")?.[1];
  if (!shape || !run) throw new Error(`${tool} can't run from the tree`);
  // the tree gives a tool its project and node when it takes them and the node doesn't say
  const given: Record<string, unknown> = { ...args };
  if ("project_folder" in shape && given.project_folder === undefined && ctx.project) given.project_folder = ctx.project;
  if ("node" in shape && given.node === undefined && ctx.node) given.node = ctx.node;
  if ("dry_run" in shape) given.dry_run = !real;
  const r = await run(z.object(shape).parse(given));
  const text = r?.content?.[0]?.text ?? "{}";
  let body: any;
  try { body = JSON.parse(text); } catch { body = { text }; }
  // a short answer: the plan keeps the top-level facts, not every drawn board
  const keep: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) if (typeof v !== "object" || v === null || (Array.isArray(v) && v.length <= 5)) keep[k] = v;
  return { ok: !r?.isError, ...keep };
}

export async function runFmcTree(args: FmcTreeArgs) {
  const { config } = loadConfig();
  const project = expandEnv(args.project_folder.trim());
  if (!project) return reply({ refused: true, reasons: ["Set the project folder: the tree lives in its 01_WIP"] }, true);
  const file = treeFile(project), state = stateFile(project);
  try {
    if (args.action === "init") {
      if (fs.existsSync(file)) return reply({ refused: true, reasons: [`The project has a tree already: ${file}`] }, true);
      const v = checkWritePath(file, config, { checkName: false });
      if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
      if (args.dry_run) return reply({ dry_run: true, would_write: file, sample: "an ICU bay: the room, its ceiling, bedhead, bed, light, door, window", next: "Run again with dry_run=false" });
      fs.mkdirSync(win.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(ICU_BAY_SAMPLE, null, 2));
      log(config, "tree_init", false, file, "written", "ICU bay sample");
      return reply({ done: true, file, next: "fmc_tree plan, then set a room's inputs and plan again" });
    }
    if (!fs.existsSync(file)) return reply({ refused: true, reasons: [`No tree yet: ${file} (fmc_tree init writes a sample)`] }, true);
    const tree: Tree = TREE.parse(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")));
    const last: BuiltState | null = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : null;

    if (args.action === "show") {
      const outline = resolve(tree).map((r) => `${"  ".repeat(r.path.length - 1)}${r.node.id} (${r.node.kind})${r.node.make ? ` ← ${r.node.make.tool}` : ""}`);
      return reply({ file, project: tree.project, nodes: outline.length, outline });
    }
    if (args.action === "check") {
      const problems = treeProblems(tree, toolExists);
      return reply({ file, ok: problems.length === 0, problems });
    }
    if (args.action === "plan") {
      let lines = planTree(tree, last);
      if (args.id) {
        const under = new Set(resolve({ ...tree, root: findNode(tree, args.id) ?? tree.root }).map((r) => r.node.id));
        lines = lines.filter((l) => under.has(l.id));
      }
      const changed = lines.filter((l) => l.state !== "unchanged");
      const would: Record<string, unknown> = {};
      if (args.run_tools) {
        const byId = new Map(resolve(tree).map((r) => [r.node.id, r]));
        for (const l of changed.filter((x) => x.tool && !x.error)) {
          const r = byId.get(l.id)!;
          try { would[l.id] = await dryRunTool(r.node.make!.tool, r.args ?? {}); }
          catch (e) { would[l.id] = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
        }
      }
      return reply({ file, last_built: last?.built_at ?? "never", nodes: lines.length, to_build: changed.filter((l) => l.tool).length,
        changed: changed.map((l) => ({ ...l, ...(would[l.id] ? { would: would[l.id] } : {}) })), unchanged: lines.length - changed.length,
        next: changed.length ? "Build the changed nodes (T1), then fmc_tree built ids=[…]" : "Nothing changed since the last build" });
    }
    const v = checkWritePath(file, config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    if (args.action === "set") {
      const node = findNode(tree, args.id);
      if (!node) return reply({ refused: true, reasons: [`No node ${args.id} (fmc_tree show lists them)`] }, true);
      const before = { ...(node.inputs ?? {}) };
      node.inputs = { ...before, ...args.inputs };
      const after = planTree(tree, last).filter((l) => l.state !== "unchanged" && l.tool).map((l) => l.id);
      if (args.dry_run) return reply({ dry_run: true, node: args.id, before, after: node.inputs, would_rebuild: after, next: "Run again with dry_run=false" });
      const archive = win.join(win.dirname(file), "_Archive");
      fs.mkdirSync(archive, { recursive: true });
      fs.copyFileSync(file, win.join(archive, `FMC_Recipe_Tree_${Date.now()}.json`));
      fs.writeFileSync(file, JSON.stringify(tree, null, 2));
      log(config, "tree_set", false, file, "written", `${args.id}: ${Object.keys(args.inputs).join(", ")}`);
      return reply({ done: true, node: args.id, inputs: node.inputs, to_rebuild: after });
    }
    if (args.action === "build") {
      const lines = planTree(tree, last).filter((l) => l.state !== "unchanged" && l.tool);
      if (lines.some((l) => l.error)) return reply({ refused: true, reasons: lines.filter((l) => l.error).map((l) => `${l.path}: ${l.error}`) }, true);
      if (!lines.length) return reply({ done: true, built: [], note: "Nothing changed since the last build" });
      if (args.dry_run) return reply({ dry_run: true, would_build: lines.map((l) => ({ id: l.id, path: l.path, tool: l.tool })), next: "Run again with dry_run=false (each tool keeps its own guard: live models stay locked)" });
      const byId = new Map(resolve(tree).map((r) => [r.node.id, r]));
      const done: string[] = [], answers: Record<string, unknown> = {};
      let stopped: string | undefined;
      for (const l of lines) {
        const r = byId.get(l.id)!;
        try {
          const a = await dryRunTool(r.node.make!.tool, r.args ?? {}, true, { project, node: l.id }) as { ok: boolean };
          answers[l.id] = a;
          if (!a.ok) { stopped = l.id; break; }
          done.push(l.id);
        } catch (e) { answers[l.id] = { ok: false, error: e instanceof Error ? e.message : String(e) }; stopped = l.id; break; }
      }
      const next = recordBuilt(tree, last, done, new Date());
      fs.mkdirSync(win.dirname(state), { recursive: true });
      fs.writeFileSync(state, JSON.stringify(next, null, 2));
      log(config, "tree_build", false, file, stopped ? `stopped at ${stopped}` : "built", `${done.length} of ${lines.length} nodes`);
      return reply({ done: !stopped, built: done, ...(stopped ? { stopped_at: stopped } : {}), answers, next: stopped ? `Fix ${stopped} and build again: only what is left is built` : "Built: the next plan shows only what changes" }, !!stopped);
    }
    // built
    if (!args.ids.length) return reply({ refused: true, reasons: ["Name the nodes the build made (ids)"] }, true);
    if (args.dry_run) return reply({ dry_run: true, would_record: args.ids, next: "Run again with dry_run=false" });
    const next = recordBuilt(tree, last, args.ids, new Date());
    fs.writeFileSync(state, JSON.stringify(next, null, 2));
    log(config, "tree_built", false, state, "recorded", args.ids.join(", "));
    return reply({ done: true, recorded: args.ids, state });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(config, "tree_" + args.action, args.dry_run, file, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcTreeTool(server: McpServer) {
  server.tool("fmc_tree", FMC_TREE_DESCRIPTION, FMC_TREE_SHAPE, (args) => runFmcTree(args));
}
