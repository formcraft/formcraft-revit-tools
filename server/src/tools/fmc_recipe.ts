import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { opsProblems, splitProblems } from "../fmc/ops.js";
import { BRIDGE_LIMIT_BYTES, CHUNK_BYTES, DEFAULT_CHUNK_OPS, applyEnvelope, dropTemplateNotes, planChunks, requestBytes, templatePlanes } from "../fmc/recipebuild.js";
import { buildRecipe, cleanupBackground } from "./fmc_recipe_build.js";
import { softTimeoutMs } from "../utils/SocketClient.js";
import { Recipe, gateA, parseRecipe, releasePath, roleOf, stagingPath } from "../fmc/recipes.js";
import { runFmcDoc } from "./fmc_doc.js";
import { runFmcLibrary } from "./fmc_library.js";
import { readDb } from "./fmc_material.js";

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

/** fmc_doc for a build: the call's own defaults, the reply as parsed JSON with ok. */
const docCall = async (a: Record<string, unknown>) =>
  body(await runFmcDoc({ template: "", file: "", session: "", ops: [], dry_run: true, path: "", overwrite: false, ...a } as any));

export const FMC_RECIPE_DESCRIPTION =
  "Formcraft family recipes and Gate A (Phase 2). A recipe (fmc-recipe/0.1: template, fmc_doc ops, each value's source " +
    "status verified/EA/assumed/pending, code checks) builds a family in staging. check (read-only) validates a recipe and " +
    "says whether its ops fit one call to Revit. build opens the template in the background, applies the ops (a dry run " +
    "unless dry_run is false), flexes every type, saves to <family_staging_root>\\<Role>\\<family>.rfa with the recipe beside " +
    "it, and runs Gate A. A recipe bigger than one call to Revit takes builds with stepwise: true: the ops go in chunks " +
    "(chunk_size), one TransactionGroup each, with a result per chunk; each call does what fits in its time and says how far " +
    "it got, and resume: true carries on from the last good op (same recipe_file, dry_run and stepwise). A failed build " +
    "closes the template without saving and says which op stopped it. cleanup lists the background family documents builds " +
    "left open (dry run) and closes them without saving (dry_run false); never a document a person opened. gate runs Gate A " +
    "on a staged family: the library's checks (name, kit parameters by GUID, type keynotes, size, type names), category " +
    "against the register, flex, labelled dimensions keeping their planes' sides, code checks (clear opening), IFC class and " +
    "value sources; tags, schedules and detail levels need the chain-test load test and are listed as not checked. Release " +
    "to 04_Families is a person's act in the pane, never this tool.";

export const FMC_RECIPE_SHAPE = {
  action: z.enum(["check", "build", "gate", "cleanup"]),
  recipe_file: z.string().optional().default("").describe("check, build: the recipe (.json)"),
  file: z.string().optional().default("").describe("gate: the staged family (.rfa); its recipe is read from <name>.recipe.json beside it"),
  dry_run: z.boolean().optional().default(true),
  overwrite: z.boolean().optional().default(false).describe("build: replace the staged family (a person decided)"),
  stepwise: z.boolean().optional().default(false).describe("build: send the ops in chunks Revit's bridge can take, one TransactionGroup per chunk"),
  chunk_size: z.number().int().min(1).max(100).optional().default(DEFAULT_CHUNK_OPS).describe("build, stepwise: most ops per chunk (chunks also stay under the bridge's size)"),
  resume: z.boolean().optional().default(false).describe("build: carry on the last build of this recipe's family from its last good op"),
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
  let inspect: any;
  try { inspect = body(await runFmcLibrary({ action: "inspect", path: file, overwrite: false, dry_run: true } as any)); }
  catch (e) { inspect = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  // F-039: never "couldn't be inspected" without the reason
  const inspectError = inspect.plan ? "" : String(inspect.error ?? (inspect.reasons ?? []).join("; ") ?? "") || "fmc_library inspect gave no plan";
  let flexResult = flex;
  let flexError = "";
  if (!flexResult) {
    const open = body(await runFmcDoc({ action: "open", file, template: "", session: "", ops: [], dry_run: true, path: "", overwrite: false }));
    if (open.session) {
      flexResult = body(await runFmcDoc({ action: "flex", session: open.session, template: "", file: "", ops: [], dry_run: true, path: "", overwrite: false }));
      await runFmcDoc({ action: "close", session: open.session, template: "", file: "", ops: [], dry_run: true, path: "", overwrite: false });
    } else flexError = String(open.error ?? (open.reasons ?? []).join("; ") ?? "");
  }
  const gate = gateA(family, recipe, { inspect: inspect.plan ?? null, inspectError, flex: flexResult as any, flexError, registerCategory: registerCategory(cfg, family) });
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

    if (args.action === "cleanup") {
      const r = await cleanupBackground(dry, expandEnv(config.reports_dir), docCall);
      if (!dry) log(config, "recipe_cleanup", false, "background documents", r.isError ? "error" : "done", JSON.stringify((r.body as any).closed ?? r.body).slice(0, 400));
      return reply(r.body, r.isError);
    }

    const { recipe, problems } = readRecipe(args.recipe_file.trim());
    if (!recipe) return reply({ refused: true, reasons: problems }, true);
    let dictionary = null;
    try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { dictionary = null; }
    const materials = recipe.ops.some((o) => o.op === "add_material") ? readDb(config) : undefined;
    const { errors, notes } = splitProblems(opsProblems(recipe.ops, dictionary, win.dirname(expandEnv(config.family_staging_root)), materials));
    const target = stagingPath(expandEnv(config.family_staging_root), recipe.family);
    const sources = Object.fromEntries(["verified", "EA", "assumed", "pending"].map((s) => [s, Object.entries(recipe.values).filter(([, v]) => v.source_status === s).map(([k]) => k)]));
    const template = win.isAbsolute(recipe.template) ? recipe.template : win.join(config.family_template_dir, recipe.template);
    // F-038: the template's own planes (Left, Right, Exterior, Head…) aren't "not made earlier"
    const planes = templatePlanes(template, expandEnv(config.reports_dir));
    const shown = dropTemplateNotes(notes, planes.planes);
    if (args.action === "check") {
      const envelope = requestBytes("fmc_doc_apply", applyEnvelope("00000000", expandEnv(config.shared_parameter_file)));
      const bytes = envelope + Buffer.byteLength(JSON.stringify(recipe.ops), "utf8");
      const chunks = planChunks(recipe.ops, args.chunk_size, CHUNK_BYTES, envelope);
      return reply({ family: recipe.family, role: roleOf(recipe.family), template: recipe.template, ops: recipe.ops.length, errors, notes: shown.notes,
        template_planes: { planes: planes.planes, source: planes.source, notes_dropped: shown.dropped }, sources,
        bridge: { bytes, limit: BRIDGE_LIMIT_BYTES, fits_one_call: bytes <= BRIDGE_LIMIT_BYTES, stepwise_chunks: chunks.chunks.length,
          too_big_ops: chunks.tooBig.map((t) => t.op), build_with: bytes <= BRIDGE_LIMIT_BYTES ? "build" : "build with stepwise: true" },
        staging: target, release_to: releasePath(expandEnv(config.family_staging_root), recipe.family), ready: errors.length === 0 && chunks.tooBig.length === 0 });
    }

    // build
    if (errors.length) return reply({ refused: true, reasons: errors }, true);
    if (!roleOf(recipe.family)) return reply({ refused: true, reasons: [`${recipe.family} doesn't follow FMC_<Role>_<Token>_<Description>`] }, true);
    const where = checkWritePath(target, config);
    if (!where.ok) return reply({ refused: true, reasons: where.reasons }, true);
    if (fs.existsSync(target) && !args.overwrite) return reply({ refused: true, reasons: [`${target} exists: a person decides to overwrite (overwrite: true)`] }, true);
    const soft = softTimeoutMs();
    const r = await buildRecipe(recipe, {
      recipeFile: args.recipe_file.trim(), template, target, dry, overwrite: args.overwrite, stepwise: args.stepwise, chunkSize: args.chunk_size,
      resume: args.resume, reportsDir: expandEnv(config.reports_dir), sharedParameterFile: expandEnv(config.shared_parameter_file),
      notes: shown.notes, sources,
    }, { doc: docCall, gate: (file, flex) => runGate(file, config, flex), budgetMs: soft > 0 ? Math.max(soft - 15000, 10000) : Infinity });
    const b = r.body as Record<string, any>;
    if (b.built || b.failed || b.dry_run) log(config, "recipe_build", dry, target, b.built ? b.gate?.verdict ?? "built" : b.failed ? "failed" : "dry run",
      b.failed ? `${b.failed_at?.text ?? ""} · ${b.ops_done}` : `${recipe.ops.length} ops${args.stepwise ? " stepwise" : ""}`);
    return reply(b, r.isError);
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
