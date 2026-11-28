import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { hostTestKind, parseRecipe } from "../fmc/recipes.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { JobStillRunning } from "../utils/SocketClient.js";
import { registerHost } from "./fmc_recipe.js";
import { LEGEND_VIEW_FIELDS, runLegendViews, type LegendViewArgs } from "../fmc/legendrun.js";

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

export const FMC_LEGEND_DESCRIPTION =
  "Formcraft legends. chain (F-064 #6): a role's chain-test project made from its template (FMC_<Role>_Template_v2.2.rte " +
    "in 06_Templates\\_Staging) with every staged family of the role (04_Families\\_Staging\\<Role>) loaded and one instance " +
    "of each type placed on the host the register gives (wall face, ceiling underside, or the level), keynote-tagged when " +
    "the template has a keynote tag, a keynote legend and a type schedule per category on a sheet. Saved to " +
    "04_Families\\_ChainTests\\FMC_ChainTest_<Role>.rvt (an older one goes to _Archive). A dry run (the default) lists what " +
    "it would place. It shows each family loads, places, tags and schedules: Gate A's last Not checked line. " +
    "list_chains is read-only: the chain-test projects already made (FMC_ChainTest_<Role>.rvt in _ChainTests and _Archive), with size, date and any result JSON beside them; role filters. " +
    "seed, create_view and place are the legend-view tool. Revit cannot create a LegendComponent or a ViewLegend, so both copy a seed. " +
    "seed is read-only and returns FMC-LEGEND-NO-SEED with the fix 'place one legend component by hand once' when none exist. " +
    "create_view duplicates a seed legend (Duplicate or WithDetailing) and renames it, or copies one from another open document and reports it if Revit refuses. " +
    "place copies the seed component into a grid, then sets LEGEND_COMPONENT, LEGEND_COMPONENT_VIEW and, for a wall, LEGEND_COMPONENT_LENGTH. " +
    "Each component is its own SubTransaction. label is none, keynote or type_mark. No free text notes. If a tag cannot be placed, the type marks are returned for a schedule. " +
    "dry_run defaults to true. A write needs batch_lease and references.kit, references.standards and references.rulebook, and is fmc_legend_apply, one transaction. " +
    "document is required. The full JSON is under %LOCALAPPDATA%\\Formcraft\\legend. No pictures. " +
    "Example: action seed, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER.";

export const FMC_LEGEND_SHAPE = {
  action: z.enum(["chain", "list_chains", "seed", "create_view", "place"]),
  role: z.string().max(3).optional().default("").describe("chain: the role code, e.g. A, E, M, P"),
  folder: z.string().optional().default("").describe("chain: the staged families' folder (default <family_staging_root>\\<Role>)"),
  template: z.string().optional().default("").describe("chain: the project template (default the role's FMC_<Role>_Template_v2.2.rte)"),
  dry_run: z.boolean().optional().default(true),
  ...LEGEND_VIEW_FIELDS,
};

export type FmcLegendArgs = z.infer<z.ZodObject<typeof FMC_LEGEND_SHAPE>>;

/** The role's template: 06_Templates\_Staging\FMC_<Role>_Template_v2.2.rte under one of the template roots. */
export function roleTemplate(templateRoots: string[], role: string, exists: (f: string) => boolean): string | null {
  for (const root of templateRoots) {
    for (const f of [win.join(root, "_Staging", `FMC_${role}_Template_v2.2.rte`), win.join(root, `FMC_${role}_Template_v2.2.rte`)])
      if (exists(f)) return f;
  }
  return null;
}

/** Where chain tests go: the library root named _ChainTests, else 04_Families\_ChainTests beside the staging root. */
export function chainTestsRoot(libraryRoots: string[], stagingRoot: string): string {
  return libraryRoots.find((r) => /[\\/]_ChainTests[\\/]*$/i.test(r)) ?? win.join(win.dirname(stagingRoot.replace(/[\\/]+$/, "")), "_ChainTests");
}

export interface ChainRow { role: string; file: string; archived: boolean; bytes: number; modified: string; result?: string }

/** Research 54: the chain-test projects on disk, newest first. Reads the folder only; opens no model. */
export function listChains(root: string, role = ""): ChainRow[] {
  const rows: ChainRow[] = [];
  const want = role.trim().toUpperCase();
  for (const [dir, archived] of [[root, false], [win.join(root, "_Archive"), true]] as const) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = /^FMC_ChainTest_([A-Za-z]{1,3})(?:[_.-].*)?\.rvt$/i.exec(name);
      if (!m || /\.\d{4}\.rvt$/i.test(name)) continue;
      if (want && m[1].toUpperCase() !== want) continue;
      const file = win.join(dir, name);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      const side = file.replace(/\.rvt$/i, ".json");
      rows.push({ role: m[1].toUpperCase(), file, archived, bytes: st.size, modified: st.mtime.toISOString(), ...(fs.existsSync(side) ? { result: side } : {}) });
    }
  }
  return rows.sort((a, b) => b.modified.localeCompare(a.modified) || a.file.localeCompare(b.file));
}

export async function runFmcLegend(args: FmcLegendArgs, deps: { env?: NodeJS.ProcessEnv; guard?: GuardConfig; read?: (body: Record<string, unknown>) => Promise<unknown>; apply?: (body: Record<string, unknown>) => Promise<unknown>; reportDir?: string } = {}) {
  if (args.action === "list_chains") {
    const { config } = deps.guard ? { config: deps.guard } : loadConfig();
    const root = chainTestsRoot((config.library_roots ?? []).map((r) => expandEnv(r)), expandEnv(config.family_staging_root));
    const chains = listChains(root, args.role);
    const current = chains.filter((row) => !row.archived);
    return reply({ tool: "fmc_legend", action: "list_chains", read_only: true, saved: false, synced: false, images: [], root, exists: fs.existsSync(root), role: args.role.trim().toUpperCase() || "all",
      summary: `${current.length} current and ${chains.length - current.length} archived chain-test project${chains.length === 1 ? "" : "s"}${args.role.trim() ? " for role " + args.role.trim().toUpperCase() : ""}.`, chains,
      next: chains.length ? "Open a chain-test project in Revit to read its sheet, keynote legend and schedules." : "None yet: run action chain with dry_run true first." });
  }
  if (args.action !== "chain") return runLegendViews(args as LegendViewArgs, deps);
  const { config } = deps.guard ? { config: deps.guard } : loadConfig();
  const dry = args.dry_run !== false;
  const role = args.role.trim().toUpperCase();
  if (!role) return reply({ refused: true, reasons: ["chain needs a role code, for example A or E"] }, true);
  try {
    const staging = expandEnv(config.family_staging_root);
    const folder = args.folder.trim() || win.join(staging, role);
    if (!fs.existsSync(folder)) return reply({ refused: true, reasons: [`No staged families at ${folder}`] }, true);
    const template = args.template.trim() || roleTemplate((config.template_roots ?? []).map((r) => expandEnv(r)), role, (f) => fs.existsSync(f));
    if (!template || !fs.existsSync(template)) return reply({ refused: true, reasons: [`No template for role ${role} (FMC_${role}_Template_v2.2.rte in 06_Templates\\_Staging): give template`] }, true);
    const output = win.join(chainTestsRoot((config.library_roots ?? []).map((r) => expandEnv(r)), staging), `FMC_ChainTest_${role}.rvt`);
    const where = checkWritePath(output, config, { checkName: false });
    if (!where.ok) return reply({ refused: true, reasons: where.reasons }, true);

    const families = fs.readdirSync(folder).filter((f) => /\.rfa$/i.test(f) && !/\.\d{4}\.rfa$/i.test(f)).sort().map((f) => {
      const file = win.join(folder, f);
      const family = win.basename(f, ".rfa");
      let types = 1;
      try {
        const r = parseRecipe(fs.readFileSync(file.replace(/\.rfa$/i, ".recipe.json"), "utf8")).recipe;
        if (r) types = Math.max(1, r.ops.filter((o) => o.op === "add_type").length);
      } catch { /* no recipe beside it: one type assumed for the layout */ }
      const registered = registerHost(config, family);
      return { path: file, family, host: hostTestKind(registered) ?? "level", types, in_register: registered !== null };
    });
    if (!families.length) return reply({ refused: true, reasons: [`No .rfa files in ${folder}`] }, true);
    const hosts = families.reduce((t, f) => ({ ...t, [f.host]: (t[f.host] ?? 0) + 1 }), {} as Record<string, number>);
    // the host comes from the register only (rule 7): a family it doesn't list goes on the level, and is named here
    const missing = families.filter((f) => !f.in_register).map((f) => f.family);
    const summary = { role, template, output, families: families.length, types: families.reduce((t, f) => t + f.types, 0), hosts,
      not_in_register: missing.length, not_in_register_list: missing.slice(0, 40),
      list: families.slice(0, 40).map((f) => `${f.family} (${f.host}, ${f.types} type${f.types === 1 ? "" : "s"})`) };
    if (dry) return reply({ dry_run: true, ...summary, next: "Run again with dry_run=false to make the chain-test project" });

    log(config, "legend_chain", false, output, "sent", `${families.length} families`);
    try {
      const r = await withRevitConnection((c) => c.sendRaw("fmc_legend_chain",
        { template, output, families: families.map(({ path: p, host, types }) => ({ path: p, host, types })) }, 12 * 60 * 60 * 1000));
      log(config, "legend_chain", false, output, "done", `${(r as any)?.placed_all ?? 0} placed in full`);
      return reply({ ...summary, revit: r, next: "Open the chain-test project to look at the sheet, the keynote legend and the schedules" });
    } catch (e) {
      if (e instanceof JobStillRunning)
        return reply({ ...summary, running: true, job: e.job, next: `It builds in Revit now (job ${e.job}): fmc_job status ${e.job}, then fmc_job result ${e.job}` });
      throw e;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "legend_" + args.action, dry, role, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcLegendTool(server: McpServer) {
  server.tool("fmc_legend", FMC_LEGEND_DESCRIPTION, FMC_LEGEND_SHAPE, (args) => runFmcLegend(args));
}
