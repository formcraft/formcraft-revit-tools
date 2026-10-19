import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { BuiltState, TREE, Tree, findNode, planTree, recordBuilt, resolve, treeProblems } from "../tree/tree.js";
import { ICU_BAY_SAMPLE } from "../tree/samples.js";
import { ROOM } from "../tree/room.js";
import { adoptEdit } from "../tree/drift.js";
import { DEPARTMENT, applyLayout, layoutDepartment } from "../tree/department.js";
import { treeFromBrief, treeQuantities } from "../tree/building.js";
import { parseCis } from "../fmc/brief.js";
import { quantityCsv, treeSearchSets } from "../tree/apps.js";
import { addVariant, compareOptions, optionSheet, planSvg, withActive } from "../tree/options.js";
import { exchangeRoot, writePackage } from "../hub/exchange.js";
import { navisCall, processAlive, readState } from "../fmc/navis.js";
import { roomEdits } from "./fmc_room.js";

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
    "plan lists only what changed. edits (T3, a room node): what people changed by hand since its build. adopt (T3): " +
    "for each edit's key, adopt (the recipe takes the move, the type, the sill; ${var} sizes stay) or override (the " +
    "element is the person's: rebuilds leave it), recorded on the node; a dry run first. layout (T4, a department node whose " +
    "inputs hold layout: corridor, north and south rows of rooms, and template: a room node to copy): every room gets its " +
    "origin and the walls it builds (a shared wall once), and becomes a child node; a changed layout updates only the " +
    "rooms it moves or resizes, keeping their adopted edits (refresh re-copies them from the template). brief (T5): the " +
    "approved CIS (cis_file) becomes the whole tree: levels, a department per FMC_Department laid out along a corridor, " +
    "each room copied from a library template (never built itself) with its number, name and programme data; widths come " +
    "from FMC_Target_Area over the template's depth and the dry run lists every size and where it came from (replace " +
    "archives an existing tree). quantities (T5): planned against target area per room, department and level, walls, " +
    "doors, windows, and every room's own checks. export (T6): to powerbi, the quantities as tidy CSV in an exchange " +
    "package; to navisworks, a search set per room (and per level and department) finding its items by the tree's mark " +
    "in their Revit Comments, sent through the Formcraft Navisworks bridge into the open document (a dry run first; " +
    "saving the .nwf is a person's step). options (docs/PLAN_OPTIONS.md, O0, O1): op add (a variant of a node: the inputs " +
    "that differ), activate (the variant the tree builds; variant empty: the node as it is), remove, compare (the node as " +
    "it is and each variant measured from the recipes, without Revit: area against the brief, wall and ceiling area, " +
    "doors, windows, family counts, each room's checks, a daylight proxy; quantities only, never rates or a ranking; with " +
    "dry_run false a sheet, a CSV and a plan sketch per option go to 01_WIP\\_Options). A person chooses. It never changes a model by itself.";

export const FMC_TREE_SHAPE = {
  action: z.enum(["show", "check", "plan", "set", "init", "built", "build", "edits", "adopt", "layout", "brief", "quantities", "export", "options"]),
  to: z.enum(["powerbi", "navisworks"]).optional().describe("export: which app"),
  op: z.enum(["add", "activate", "remove", "compare"]).optional().describe("options: what to do"),
  variant: z.string().optional().default("").describe("options: the variant's id (activate with none: the node as it is)"),
  name: z.string().optional().default("").describe("options add: the variant's name, e.g. 4.5 m bays"),
  note: z.string().optional().default("").describe("options add: why this option"),
  cis_file: z.string().optional().default("").describe("brief: the approved CIS .json (fmc-cis/0.1)"),
  brief: z.object({
    wall_type: z.string().min(1), wall_thickness: z.number().positive(), ceiling_type: z.string().min(1), ceiling_height: z.number().positive(),
    corridor_width: z.number().positive(),
    level_prefixes: z.record(z.string(), z.string()).optional(),
    templates: z.array(z.object({ match: z.string(), template: z.string() })).optional(),
    default_template: z.string().optional(), top_structure_height: z.number().positive().optional(),
  }).optional().describe("brief: the project template's wall and ceiling types, the corridor width, and how rooms find their level and template"),
  replace: z.boolean().optional().default(false).describe("brief: replace an existing tree (it is archived first)"),
  tolerance_pct: z.number().optional().default(10).describe("quantities: how far a room may be off its target area"),
  choices: z.array(z.object({ key: z.string(), choice: z.enum(["adopt", "override"]) })).optional().default([])
    .describe("adopt: per hand edit's key (from edits), adopt it into the recipe or keep it as an override"),
  by: z.string().optional().default("").describe("adopt: who decided (recorded on the node)"),
  refresh: z.boolean().optional().default(false).describe("layout: also re-copy existing rooms from their template (their adopted edits are lost)"),
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
    if (args.action === "brief") {
      if (!args.cis_file.trim()) return reply({ refused: true, reasons: ["Give the approved CIS (cis_file)"] }, true);
      if (!args.brief) return reply({ refused: true, reasons: ["Give brief: wall_type, wall_thickness, ceiling_type, ceiling_height (the project template's) and corridor_width"] }, true);
      const cisPath = expandEnv(args.cis_file.trim());
      if (!fs.existsSync(cisPath)) return reply({ refused: true, reasons: [`No CIS at ${cisPath}`] }, true);
      const { cis, problems: cisProblems } = parseCis(fs.readFileSync(cisPath, "utf8"));
      if (!cis || cisProblems.length) return reply({ refused: true, reasons: cisProblems }, true);
      const made = treeFromBrief(cis, args.brief);
      const q = treeQuantities(made.tree, args.tolerance_pct);
      const body = { cis: `${cis.project} ${cis.revision}`, levels: made.tree.root.children!.filter((c) => c.kind === "level").map((l) => l.name),
        rooms: made.sizes, warnings: made.warnings, problems: [...made.problems, ...q.problems], total: q.total, off_target: q.off_target };
      if (args.dry_run || made.problems.length) return reply({ dry_run: true, would_write: file, ...body,
        next: made.problems.length ? "Settle the problems (the CIS or the options), then run again" : fs.existsSync(file) && !args.replace ? "A tree exists: run with replace=true (archived first) and dry_run=false" : "Run again with dry_run=false" }, made.problems.length > 0);
      if (fs.existsSync(file) && !args.replace) return reply({ refused: true, reasons: [`The project has a tree already: ${file} (replace=true archives it first)`] }, true);
      const v4 = checkWritePath(file, config, { checkName: false });
      if (!v4.ok) return reply({ refused: true, reasons: v4.reasons }, true);
      fs.mkdirSync(win.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        const archive = win.join(win.dirname(file), "_Archive");
        fs.mkdirSync(archive, { recursive: true });
        fs.copyFileSync(file, win.join(archive, `FMC_Recipe_Tree_${Date.now()}.json`));
      }
      fs.writeFileSync(file, JSON.stringify(made.tree, null, 2));
      log(config, "tree_brief", false, file, "written", `${cis.project} ${cis.revision}: ${made.sizes.length} rooms`);
      return reply({ done: true, file, ...body, next: "fmc_tree check, plan, then build (families first, then each room)" });
    }
    if (!fs.existsSync(file)) return reply({ refused: true, reasons: [`No tree yet: ${file} (fmc_tree init writes a sample, brief writes one from the CIS)`] }, true);
    const tree: Tree = TREE.parse(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")));
    const last: BuiltState | null = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : null;

    if (args.action === "show") {
      const outline = resolve(tree).map((r) => `${"  ".repeat(r.path.length - 1)}${r.node.id} (${r.node.kind})${r.node.make ? ` ← ${r.node.make.tool}` : ""}`);
      return reply({ file, project: tree.project, nodes: outline.length, outline });
    }
    if (args.action === "quantities") {
      const q = treeQuantities(tree, args.tolerance_pct);
      return reply({ file, total: q.total, by_level: q.by_level, by_department: q.by_department, off_target: q.off_target, problems: q.problems,
        rooms: args.id ? q.rows.filter((r) => r.node.startsWith(args.id)) : q.rows.length <= 40 ? q.rows : `${q.rows.length} rooms: name an id to list a part` });
    }
    if (args.action === "options") {
      const node = findNode(tree, args.id);
      if (!node) return reply({ refused: true, reasons: [`No node ${args.id} (fmc_tree show lists them)`] }, true);
      if (!args.op) return reply({ refused: true, reasons: ["Say op: add, activate, remove or compare"] }, true);
      if (args.op === "compare") {
        const c = compareOptions(tree, node.id, args.tolerance_pct);
        if (c.options.length < 2) return reply({ refused: true, reasons: [`${node.id} has no variants yet (options op=add)`] }, true);
        const sheet = optionSheet(c, node.name ?? node.id);
        if (args.dry_run) return reply({ node: node.id, active: node.active ?? "base", options: c.options, differs: c.differs,
          next: "A person weighs these; dry_run=false keeps the sheet, CSV and plan sketches in 01_WIP; options op=activate makes one the tree's" });
        const dir = win.join(project, "01_WIP", "_Options", node.id.replace(/[^A-Za-z0-9_.-]/g, "_"), new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
        const vo = checkWritePath(win.join(dir, "x.md"), config, { checkName: false });
        if (!vo.ok) return reply({ refused: true, reasons: vo.reasons }, true);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(win.join(dir, "FMC_Options.md"), sheet);
        fs.writeFileSync(win.join(dir, "FMC_Options.csv"), csvLine(["variant", "name", "rooms", "area_m2", "target_m2", "walls_m2", "ceilings_m2", "doors", "windows", "glazing_m2", "daylight_pct", "off_target", "problems"]) +
          c.options.map((o) => csvLine([o.variant, o.name, o.rooms, o.area_m2, o.target_m2, o.walls_m2, o.ceilings_m2, o.doors, o.windows, o.glazing_m2 ?? "", o.daylight_pct ?? "", o.off_target.length, o.problems.length])).join(""));
        for (const o of c.options) fs.writeFileSync(win.join(dir, `Plan_${o.variant}.svg`), planSvg(withActive(tree, node.id, o.variant === "base" ? null : o.variant), node.id));
        log(config, "tree_options", false, dir, "written", `${node.id}: ${c.options.length} options`);
        return reply({ done: true, node: node.id, folder: dir, options: c.options.map((o) => o.variant), differs: c.differs });
      }
      const before = JSON.stringify(node);
      if (args.op === "add") {
        if (!args.variant) return reply({ refused: true, reasons: ["Name the variant (variant), e.g. wide"] }, true);
        if (!Object.keys(args.inputs).length) return reply({ refused: true, reasons: ["Give the inputs that differ (inputs), e.g. { \"width\": 4500 }"] }, true);
        addVariant(node, { id: args.variant, name: args.name || undefined, note: args.note || undefined, inputs: args.inputs });
      } else if (args.op === "activate") {
        if (args.variant && !node.variants?.some((v) => v.id === args.variant)) return reply({ refused: true, reasons: [`${node.id} has no variant ${args.variant}`] }, true);
        if (args.variant) node.active = args.variant; else delete node.active;
      } else {
        if (!node.variants?.some((v) => v.id === args.variant)) return reply({ refused: true, reasons: [`${node.id} has no variant ${args.variant}`] }, true);
        if (node.active === args.variant) return reply({ refused: true, reasons: [`${args.variant} is the active variant: activate another first`] }, true);
        node.variants = node.variants!.filter((v) => v.id !== args.variant);
        if (!node.variants.length) delete node.variants;
      }
      const would = planTree(tree, last).filter((l) => l.state !== "unchanged" && l.tool).map((l) => l.id);
      if (args.dry_run) return reply({ dry_run: true, node: node.id, op: args.op, variant: args.variant || "base", would_rebuild: args.op === "activate" ? would : [], next: "Run again with dry_run=false" });
      const vt = checkWritePath(file, config, { checkName: false });
      if (!vt.ok) return reply({ refused: true, reasons: vt.reasons }, true);
      const archive = win.join(win.dirname(file), "_Archive");
      fs.mkdirSync(archive, { recursive: true });
      fs.copyFileSync(file, win.join(archive, `FMC_Recipe_Tree_${Date.now()}.json`));
      node.overrides = [...(node.overrides ?? []), { what: `options ${args.op} ${args.variant || "base"}`, by: args.by.trim() || "Claude (via MCP)", at: new Date().toISOString() }];
      fs.writeFileSync(file, JSON.stringify(tree, null, 2));
      log(config, "tree_options", false, file, "written", `${node.id}: ${args.op} ${args.variant}`);
      return reply({ done: true, node: node.id, op: args.op, variant: args.variant || "base", changed: before !== JSON.stringify(node), to_rebuild: args.op === "activate" ? would : [] });
    }
    if (args.action === "export") {
      if (!args.to) return reply({ refused: true, reasons: ["Say which app: to powerbi or navisworks"] }, true);
      const root = exchangeRoot(project, expandEnv(config.reports_dir));
      const vx = checkWritePath(win.join(root, "Packages", "x.json"), config, { checkName: false });
      if (args.to === "powerbi") {
        const files = quantityCsv(tree, args.tolerance_pct);
        if (args.dry_run) return reply({ dry_run: true, to: "powerbi", would_write: root, files: files.map((f) => ({ name: f.name, rows: f.text.trim().split(/\r?\n/).length - 1 })), next: "Run again with dry_run=false; point Power BI at the newest package" });
        if (!vx.ok) return reply({ refused: true, reasons: vx.reasons }, true);
        const pkg = writePackage(root, { from: "hub", to: "powerbi", what: "Recipe tree quantities", files, source: { tree: file } });
        log(config, "tree_export", false, pkg.dir, "written", "powerbi");
        return reply({ done: true, to: "powerbi", package: pkg.dir, files: pkg.manifest.files.map((f) => f.name) });
      }
      const sets = treeSearchSets(tree);
      if (!sets.length) return reply({ refused: true, reasons: ["The tree has no rooms built by fmc_room"] }, true);
      const st = readState();
      const open = !!st && processAlive(st.pid);
      if (args.dry_run) return reply({ dry_run: true, to: "navisworks", sets: sets.length, sample: sets.slice(0, 6), navisworks_open: open,
        next: open ? "Run again with dry_run=false: the sets go into the open document's 'FMC Recipe tree' folder" : "Open Navisworks with the Formcraft bridge (fmc_navis status), then run again with dry_run=false" });
      if (!open) return reply({ refused: true, reasons: ["Navisworks with the Formcraft bridge isn't open (fmc_navis status)"] }, true);
      const r = await navisCall(st!.port, "navis_search_sets", { folder: "FMC Recipe tree", sets, dry_run: false });
      if (vx.ok) writePackage(root, { from: "hub", to: "navisworks", what: "Recipe tree search sets", files: [{ name: "FMC_Tree_SearchSets.json", text: JSON.stringify(sets, null, 2) }], source: { tree: file } });
      log(config, "tree_export", false, file, "sent", `navisworks: ${sets.length} sets`);
      return reply({ done: true, to: "navisworks", ...r, next: "Save the .nwf to keep them (a person's step); clash tests can use the department sets" });
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
    if (args.action === "edits" || args.action === "adopt") {
      const node = findNode(tree, args.id);
      if (!node) return reply({ refused: true, reasons: [`No node ${args.id} (fmc_tree show lists them)`] }, true);
      if (node.make?.tool !== "fmc_room") return reply({ refused: true, reasons: [`${args.id} isn't made by fmc_room: hand edits are traced for rooms (T3)`] }, true);
      const { record, edits } = await roomEdits(project, node.id);
      if (args.action === "edits")
        return reply({ node: node.id, built_at: record.built_at, kept: record.keep ?? [], edits,
          next: edits.length ? "fmc_tree adopt with choices [{ key, choice: adopt | override }] (a dry run first)" : "No hand edits since the build" });
      if (!args.choices.length) return reply({ refused: true, reasons: ["Say for each edit's key: adopt or override (choices)"] }, true);
      const resolved = resolve(tree).find((r) => r.node.id === node.id);
      const sized = ROOM.parse((resolved?.args as any)?.room);
      // worked on a copy: the dry run shows it, the real run writes it
      const args2 = JSON.parse(JSON.stringify(node.make.args)) as Record<string, any>;
      const done: string[] = [], refused: string[] = [];
      for (const c of args.choices) {
        const mine = edits.filter((e) => e.key === c.key);
        if (!mine.length) { refused.push(`${c.key}: no hand edit (fmc_tree edits lists them)`); continue; }
        if (c.choice === "override") {
          args2.keep = [...new Set([...(args2.keep ?? []), c.key])];
          done.push(`${c.key} is kept as the person left it (${mine.map((e) => e.kind).join(", ")}): rebuilds leave it`);
          continue;
        }
        for (const e of mine) {
          try { done.push(adoptEdit(args2.room, sized, e)); } catch (err) { refused.push(err instanceof Error ? err.message : String(err)); }
        }
      }
      if (args.dry_run) return reply({ dry_run: true, node: node.id, would: done, refused, next: "Run again with dry_run=false; the next build rebuilds the room with these" });
      if (!done.length) return reply({ refused: true, reasons: refused }, true);
      const v2 = checkWritePath(file, config, { checkName: false });
      if (!v2.ok) return reply({ refused: true, reasons: v2.reasons }, true);
      const archive = win.join(win.dirname(file), "_Archive");
      fs.mkdirSync(archive, { recursive: true });
      fs.copyFileSync(file, win.join(archive, `FMC_Recipe_Tree_${Date.now()}.json`));
      const by = args.by.trim() || "Claude (via MCP)", at = new Date().toISOString();
      node.make.args = args2;
      node.overrides = [...(node.overrides ?? []), ...done.map((what) => ({ what, by, at }))];
      fs.writeFileSync(file, JSON.stringify(tree, null, 2));
      log(config, "tree_adopt", false, file, "written", `${node.id}: ${done.length} decided`);
      return reply({ done: true, node: node.id, decided: done, refused, next: "fmc_tree build: the room rebuilds with them; kept elements stay as they are" });
    }
    if (args.action === "layout") {
      const dept = findNode(tree, args.id);
      if (!dept) return reply({ refused: true, reasons: [`No node ${args.id} (fmc_tree show lists them)`] }, true);
      const parsed = DEPARTMENT.safeParse(dept.inputs?.layout);
      if (!parsed.success) return reply({ refused: true, reasons: [`${dept.id} has no valid layout in its inputs: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`] }, true);
      const template = String(dept.inputs?.template ?? "");
      const layout = layoutDepartment(parsed.data);
      if (layout.problems.length) return reply({ refused: true, reasons: layout.problems, warnings: layout.warnings }, true);
      const next = applyLayout(dept, layout, (id) => findNode(tree, id), template, args.refresh);
      if (next.problems.length) return reply({ refused: true, reasons: next.problems }, true);
      const inside = next.children.some((c) => c.id === template) || (dept.children ?? []).some((c) => c.id === template);
      const summary = { rooms: layout.rooms.map((r) => ({ id: r.id, side: r.side, origin: r.origin, size: [r.width, r.depth], skips: r.skip })),
        corridor: { length: layout.corridor.width, width: layout.corridor.depth, skips: layout.corridor.skip }, ...next.change, warnings: layout.warnings,
        ...(inside ? { note: `The template ${template} is a room in this department too: it is built as well as its copies` } : {}),
        ...(args.refresh && next.change.update.length ? { refresh: "Re-copied rooms lose their adopted edits and overrides" } : {}) };
      if (args.dry_run) return reply({ dry_run: true, node: dept.id, ...summary, next: "Run again with dry_run=false, then fmc_tree plan: only the added and changed rooms build" });
      const v3 = checkWritePath(file, config, { checkName: false });
      if (!v3.ok) return reply({ refused: true, reasons: v3.reasons }, true);
      const archive = win.join(win.dirname(file), "_Archive");
      fs.mkdirSync(archive, { recursive: true });
      fs.copyFileSync(file, win.join(archive, `FMC_Recipe_Tree_${Date.now()}.json`));
      dept.children = next.children;
      const problems = treeProblems(tree, toolExists);
      fs.writeFileSync(file, JSON.stringify(tree, null, 2));
      log(config, "tree_layout", false, file, "written", `${dept.id}: +${next.change.add.length} ~${next.change.update.length} -${next.change.remove.length}`);
      return reply({ done: true, node: dept.id, ...summary, ...(problems.length ? { problems } : {}), next: "fmc_tree plan, then build" });
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
