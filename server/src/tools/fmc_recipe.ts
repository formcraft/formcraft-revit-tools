import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { opsProblems, splitProblems } from "../fmc/ops.js";
import { Recipe, gateA, parseRecipe, releasePath, roleOf, stagingPath } from "../fmc/recipes.js";
import { runFmcDoc } from "./fmc_doc.js";
import { runFmcLibrary } from "./fmc_library.js";

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

const body = (r: { content: Array<{ text: string }>; isError?: boolean }) => ({ ok: !r.isError, ...JSON.parse(r.content[0]?.text ?? "{}") });

export const FMC_RECIPE_DESCRIPTION =
  "Formcraft family recipes and Gate A (Phase 2). A recipe (fmc-recipe/0.1: template, fmc_doc ops, each value's source " +
    "status verified/EA/assumed/pending, code checks) builds a family in staging. check (read-only) validates a recipe. " +
    "build opens the template in the background, applies the ops (a dry run unless dry_run is false), flexes every type, " +
    "saves to <family_staging_root>\\<Role>\\<family>.rfa with the recipe beside it, and runs Gate A. gate runs Gate A on a " +
    "staged family: the library's checks (name, kit parameters by GUID, keynotes, size, type names), category against the " +
    "register, flex, code checks (clear opening), IFC class and value sources; tags, schedules and detail levels need the " +
    "chain-test load test and are listed as not checked. Release to 04_Families is a person's act in the pane, never this tool.";

export const FMC_RECIPE_SHAPE = {
  action: z.enum(["check", "build", "gate"]),
  recipe_file: z.string().optional().default("").describe("check, build: the recipe (.json)"),
  file: z.string().optional().default("").describe("gate: the staged family (.rfa); its recipe is read from <name>.recipe.json beside it"),
  dry_run: z.boolean().optional().default(true),
  overwrite: z.boolean().optional().default(false).describe("build: replace the staged family (a person decided)"),
};

export type FmcRecipeArgs = z.infer<z.ZodObject<typeof FMC_RECIPE_SHAPE>>;

function readRecipe(file: string): { recipe: Recipe | null; problems: string[] } {
  if (!file || !fs.existsSync(file)) return { recipe: null, problems: [`Recipe not found: ${file || "(none)"}`] };
  return parseRecipe(fs.readFileSync(file, "utf8"));
}

/** The register's category for a family (03_Master_Data\FMC_Family_Register.csv: Role,Family,Category,…). */
function registerCategory(cfg: GuardConfig, family: string): string | null {
  try {
    const file = win.join(win.dirname(expandEnv(cfg.specs_path)), "FMC_Family_Register.csv");
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1)) {
      const cells = line.split(",");
      if (cells[1] === family) return cells[2] ?? "";
    }
  } catch { /* no register: not checked */ }
  return null;
}

export async function runGate(file: string, cfg: GuardConfig, flex: object | null = null) {
  const family = win.basename(file, ".rfa");
  const recipeFile = file.replace(/\.rfa$/i, ".recipe.json");
  const recipe = fs.existsSync(recipeFile) ? parseRecipe(fs.readFileSync(recipeFile, "utf8")).recipe : null;
  const inspect = body(await runFmcLibrary({ action: "inspect", path: file, overwrite: false, dry_run: true } as any));
  let flexResult = flex;
  if (!flexResult) {
    const open = body(await runFmcDoc({ action: "open", file, template: "", session: "", ops: [], dry_run: true, path: "", overwrite: false }));
    if (open.session) {
      flexResult = body(await runFmcDoc({ action: "flex", session: open.session, template: "", file: "", ops: [], dry_run: true, path: "", overwrite: false }));
      await runFmcDoc({ action: "close", session: open.session, template: "", file: "", ops: [], dry_run: true, path: "", overwrite: false });
    }
  }
  const gate = gateA(family, recipe, { inspect: inspect.plan ?? null, flex: flexResult as any, registerCategory: registerCategory(cfg, family) });
  const result = { family, file, at: new Date().toISOString(), ...gate };
  try { fs.writeFileSync(file.replace(/\.rfa$/i, ".gate.json"), JSON.stringify(result, null, 2)); } catch { /* the gate still answers */ }
  return result;
}

export async function runFmcRecipe(args: FmcRecipeArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    if (args.action === "gate") {
      const file = args.file.trim();
      if (!file || !fs.existsSync(file)) return reply({ refused: true, reasons: [`Family not found: ${file || "(none)"}`] }, true);
      if (!checkWritePath(file, config, { checkName: false }).ok) return reply({ refused: true, reasons: ["Gate A runs on families in staging"] }, true);
      const g = await runGate(file, config);
      log(config, "recipe_gate", false, file, g.verdict, g.lines.filter((l) => l.state === "Fail").map((l) => l.check).join("; "));
      return reply({ ...g, next: g.verdict === "Pass" ? "A reviewer can release it in the pane (Families › Quality and release)" : "Fix what fails, rebuild, and run the gate again" });
    }

    const { recipe, problems } = readRecipe(args.recipe_file.trim());
    if (!recipe) return reply({ refused: true, reasons: problems }, true);
    let dictionary = null;
    try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { dictionary = null; }
    const { errors, notes } = splitProblems(opsProblems(recipe.ops, dictionary, win.dirname(expandEnv(config.family_staging_root))));
    const target = stagingPath(expandEnv(config.family_staging_root), recipe.family);
    const sources = Object.fromEntries(["verified", "EA", "assumed", "pending"].map((s) => [s, Object.entries(recipe.values).filter(([, v]) => v.source_status === s).map(([k]) => k)]));
    if (args.action === "check")
      return reply({ family: recipe.family, role: roleOf(recipe.family), template: recipe.template, ops: recipe.ops.length, errors, notes, sources,
        staging: target, release_to: releasePath(expandEnv(config.family_staging_root), recipe.family), ready: errors.length === 0 });

    // build
    if (errors.length) return reply({ refused: true, reasons: errors }, true);
    if (!roleOf(recipe.family)) return reply({ refused: true, reasons: [`${recipe.family} doesn't follow FMC_<Role>_<Token>_<Description>`] }, true);
    const where = checkWritePath(target, config);
    if (!where.ok) return reply({ refused: true, reasons: where.reasons }, true);
    if (fs.existsSync(target) && !args.overwrite) return reply({ refused: true, reasons: [`${target} exists: a person decides to overwrite (overwrite: true)`] }, true);
    const template = win.isAbsolute(recipe.template) ? recipe.template : win.join(config.family_template_dir, recipe.template);
    const call = (a: Record<string, unknown>) => runFmcDoc({ template: "", file: "", session: "", ops: [], dry_run: true, path: "", overwrite: false, ...a } as any);
    const open = body(await call({ action: "open", template }));
    if (!open.session) return reply({ refused: true, reasons: open.reasons ?? [open.error ?? "The template didn't open"] }, true);
    const session = open.session;
    try {
      const applied = body(await call({ action: "apply", session, ops: recipe.ops, dry_run: dry }));
      if (!applied.ok) return reply({ refused: true, reasons: applied.reasons ?? [applied.error ?? "apply failed"] }, true);
      if (dry) return reply({ dry_run: true, family: recipe.family, would_save: target, created: applied.created, updated: applied.updated, skipped: applied.skipped,
        warnings: applied.warnings ?? [], notes, sources, next: "Run again with dry_run=false to build, flex, save to staging and run Gate A" });
      const flex = body(await call({ action: "flex", session }));
      const saved = body(await call({ action: "save", session, path: target, overwrite: args.overwrite }));
      if (!saved.ok) return reply({ refused: true, reasons: saved.reasons ?? [saved.error ?? "save failed"] }, true);
      fs.writeFileSync(target.replace(/\.rfa$/i, ".recipe.json"), JSON.stringify(recipe, null, 2));
      await call({ action: "close", session });
      const gate = await runGate(target, config, flex);
      log(config, "recipe_build", false, target, gate.verdict, `${recipe.ops.length} ops`);
      return reply({ built: target, flex: { ok: flex.ok }, gate, next: gate.verdict === "Pass" ? "A reviewer releases it in the pane" : "Fix what fails and build again" });
    } finally {
      if (dry) await call({ action: "close", session });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "recipe_" + args.action, dry, args.recipe_file || args.file, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcRecipeTool(server: McpServer) {
  server.tool("fmc_recipe", FMC_RECIPE_DESCRIPTION, FMC_RECIPE_SHAPE, (args) => runFmcRecipe(args));
}

/**
 * Release and send back (pane only, never MCP tools): a person, the Family Librarian with a reviewer and a note,
 * moves a family that passed Gate A from staging to 04_Families\<Role> and the release log records it. Hard rule 2
 * keeps tools out of 04_Families\<Role>; this is a person's act, like a sync in Revit.
 */
export function paneRelease(command: string, input: Record<string, unknown>, by: string) {
  const { config } = loadConfig();
  const file = String(input.file ?? "").trim(), reviewer = String(input.reviewer ?? "").trim(), note = String(input.note ?? "").trim();
  if (!file || !fs.existsSync(file)) return { error: `Family not found: ${file || "(none)"}` };
  if (!reviewer || !note) return { error: "A reviewer and a note are needed" };
  const family = win.basename(file, ".rfa");
  const staging = expandEnv(config.family_staging_root);
  if (!win.normalize(file).toLowerCase().startsWith(win.normalize(staging).toLowerCase())) return { error: "Only families in staging are released" };
  const logFile = win.join(win.dirname(win.normalize(staging).replace(/\\+$/, "")), "FMC_Release_Log.csv");
  const write = (result: string, to: string) => {
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, csvLine(["timestamp", "family", "from", "to", "result", "reviewer", "released_by", "note"]));
    fs.appendFileSync(logFile, csvLine([new Date().toISOString(), family, file, to, result, reviewer, by, note]));
  };
  if (command === "family_sendback") { write("sent back", ""); return { sent_back: family, log: logFile }; }
  let gate: { verdict?: string } = {};
  try { gate = JSON.parse(fs.readFileSync(file.replace(/\.rfa$/i, ".gate.json"), "utf8")); } catch { return { error: "Run Gate A first: there is no gate result beside the family" }; }
  if (gate.verdict !== "Pass") return { error: "Gate A didn't pass: fix what fails and run it again" };
  const to = releasePath(staging, family);
  if (fs.existsSync(to)) return { error: `${to} exists: the Family Librarian archives the released version first` };
  fs.mkdirSync(win.dirname(to), { recursive: true });
  fs.renameSync(file, to);
  write("released", to);
  return { released: family, to, log: logFile };
}
