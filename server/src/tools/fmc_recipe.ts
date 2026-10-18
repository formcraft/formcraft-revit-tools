import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { WARNING, expandSkeletons, familyRoots, opsProblems, resolveFamilyPaths, splitProblems } from "../fmc/ops.js";
import { hostTemplateProblem } from "../fmc/opsgeom.js";
import { BRIDGE_LIMIT_BYTES, BuildRecord, CHUNK_BYTES, DEFAULT_CHUNK_OPS, applyEnvelope, dropTemplateNotes, planChunks, readBuilds, requestBytes, templatePlanes } from "../fmc/recipebuild.js";
import { buildRecipe, cleanupBackground } from "./fmc_recipe_build.js";
import { JobStillRunning, softTimeoutMs } from "../utils/SocketClient.js";
import { HostTestResult, RecordedSides, Recipe, followParams, gateA, hostTestKind, parseRecipe, releasePath, roleOf, stagingPath } from "../fmc/recipes.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { SpecFile } from "../fmc/specs.js";
import { idleLimit } from "../fmc/doc.js";
import { readXlsxSheets } from "../fmc/xlsx.js";
import { table } from "../fmc/templatekit.js";
import { csvRow } from "./fmc_sheets.js";
import { runFmcDoc } from "./fmc_doc.js";
import { runFmcLibrary } from "./fmc_library.js";
import { readDb } from "./fmc_material.js";
import { batchId, planBatch, readBatchResults, recipeRevision } from "../fmc/recipebatch.js";
import { localIso } from "../fmc/jobs.js";
import { resolveMaterial } from "../fmc/materials.js";

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
    "left open and fmc_doc sessions idle longer than the guard's session_idle_hours (default 12) (dry run) and closes them " +
    "without saving (dry_run false); an unfinished build's live session stays until stale; never a document in a Revit " +
    "window or one a person opened. gate runs Gate A " +
    "on a staged family: the library's checks by family kind (model families FMC_[Role]_[Token]_…, profiles " +
    "FMC_Profile_<Element>…, title blocks FMC_TB_*, annotations; kit parameters by GUID, never a pass on 0; type keynotes " +
    "except on title blocks and annotations; size; type names on model families), category against the register, the spec " +
    "and the name's token, flex, labelled dimensions keeping their planes' sides (from the build's record when the file " +
    "can't be flexed), code checks (clear opening), IFC class and " +
    "value sources; tags, schedules and detail levels need the chain-test load test and are listed as not checked. Release " +
    "to 04_Families is a person's act in the pane, never this tool. batch (F-063): many recipes (recipe_files, files holding " +
    "an array, or a folder) checked first like check, then built in one Revit job one after another (apply, flex, the old " +
    "staged file archived, saved to staging with its recipe); a family staged from the same recipe revision with Gate A " +
    "passed is skipped unless rebuild names it; a dry run shows the plan; results go one line per family to " +
    "<staging>\\_Batch\\<batch>.jsonl. batch_status reads them; batch_gate runs Gate A on what was built, as many as fit per call.";

export const FMC_RECIPE_SHAPE = {
  action: z.enum(["check", "build", "gate", "cleanup", "batch", "batch_status", "batch_gate"]),
  recipe_file: z.string().optional().default("").describe("check, build: the recipe (.json)"),
  recipe: z.record(z.string(), z.any()).optional().describe("check, build: the recipe itself, inline, instead of recipe_file (F-057). It is kept in <reports>\\Recipes\\<family>.recipe.json, and a real build saves it beside the staged family as always"),
  file: z.string().optional().default("").describe("gate: the staged family (.rfa); its recipe is read from <name>.recipe.json beside it"),
  dry_run: z.boolean().optional().default(true),
  overwrite: z.boolean().optional().default(false).describe("build: replace the staged family (a person decided)"),
  stepwise: z.boolean().optional().default(false).describe("build: send the ops in chunks Revit's bridge can take, one TransactionGroup per chunk"),
  chunk_size: z.number().int().min(1).max(100).optional().default(DEFAULT_CHUNK_OPS).describe("build, stepwise: most ops per chunk (chunks also stay under the bridge's size)"),
  resume: z.boolean().optional().default(false).describe("build: carry on the last build of this recipe's family from its last good op"),
  recipe_files: z.array(z.string()).optional().default([]).describe("batch: recipe files, or files holding an array of recipes"),
  folder: z.string().optional().default("").describe("batch: a folder of recipe files (every .json in it)"),
  rebuild: z.union([z.boolean(), z.array(z.string())]).optional().default(false)
    .describe("batch: true rebuilds every family, or a list of families; otherwise one staged from the same recipe revision with Gate A passed is skipped"),
  max: z.number().int().min(0).optional().default(0).describe("batch: build at most this many this run (0: all)"),
  seconds: z.number().min(0).optional().default(0).describe("batch: stop starting new families after this many seconds (0: no limit)"),
  batch: z.string().optional().default("").describe("batch_status, batch_gate: the batch (B-yyyymmdd-hhmm); batch: a name to use"),
};

export type FmcRecipeArgs = z.infer<z.ZodObject<typeof FMC_RECIPE_SHAPE>>;

function readRecipe(file: string): { recipe: Recipe | null; problems: string[] } {
  if (!file || !fs.existsSync(file)) return { recipe: null, problems: [`Recipe not found: ${file || "(none)"}`] };
  return parseRecipe(fs.readFileSync(file, "utf8"));
}

/** The register's host for a family (the Host column; null: not in the register, no Host column or no register). */
export function registerHost(cfg: GuardConfig, family: string): string | null {
  try {
    const file = win.join(win.dirname(expandEnv(cfg.specs_path)), "FMC_Family_Register.csv");
    const rows = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow);
    const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const cFam = Math.max(0, head.indexOf("family")), cHost = head.indexOf("host");
    if (cHost < 0) return null;
    for (const cells of rows.slice(1)) if ((cells[cFam] ?? "").trim() === family) return (cells[cHost] ?? "").trim() || null;
  } catch { /* no register: not checked */ }
  return null;
}

/** The register's category for a family (03_Master_Data\FMC_Family_Register.csv: Role,Family,Category,…; quoted cells read whole). */
function registerCategory(cfg: GuardConfig, family: string): string | null {
  try {
    const file = win.join(win.dirname(expandEnv(cfg.specs_path)), "FMC_Family_Register.csv");
    const rows = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow);
    const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const cFam = Math.max(0, head.indexOf("family")), cCat = head.indexOf("category") >= 0 ? head.indexOf("category") : 2;
    for (const cells of rows.slice(1)) if ((cells[cFam] ?? "").trim() === family) return (cells[cCat] ?? "").trim();
  } catch { /* no register: not checked */ }
  return null;
}

/** F-047: the family's category in FMC_Family_Specs.json (null: not there or unreadable). */
function specCategory(cfg: GuardConfig, family: string): string | null {
  try {
    const specs = JSON.parse(fs.readFileSync(expandEnv(cfg.specs_path), "utf8").replace(/^﻿/, "")) as SpecFile;
    return specs.families.find((f) => f.family === family)?.category ?? null;
  } catch { return null; }
}

/** F-047: the kit's Family_Name_Tokens (FMC_Revit_Kit.xlsx beside the specs): token → Revit category (rule 7). */
function tokenCategories(cfg: GuardConfig): Map<string, string> | null {
  try {
    const sheets = readXlsxSheets(fs.readFileSync(win.join(win.dirname(expandEnv(cfg.specs_path)), "FMC_Revit_Kit.xlsx")));
    const rows = table(sheets.get("Family_Name_Tokens"));
    const map = new Map(rows.map((r) => [String(r["Token"] ?? "").trim(), String(r["Revit category"] ?? "").trim()] as [string, string]).filter(([t, c]) => t && c));
    return map.size ? map : null;
  } catch { return null; }
}

/** F-045: the dimension sides the family's last build recorded from its own flex, when it built this file. */
function recordedSides(cfg: GuardConfig, family: string, file: string): RecordedSides | null {
  const rec: BuildRecord | undefined = readBuilds(expandEnv(cfg.reports_dir))[family];
  const built = (rec?.result as { built?: string } | undefined)?.built;
  if (!rec?.sides || (built && win.normalize(built).toLowerCase() !== win.normalize(file).toLowerCase())) return null;
  return rec.sides;
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
    const open = body(await runFmcDoc({ action: "open", file, template: "", session: "", ops: [], dry_run: true, path: "", overwrite: false, detail_level: "fine", style: "shaded", views: ["3d"] }));
    if (open.session) {
      const follow = recipe ? followParams(recipe) : [];
      flexResult = body(await runFmcDoc({ action: "flex", session: open.session, template: "", file: "", ops: [], dry_run: true, path: "", overwrite: false, follow, detail_level: "fine", style: "shaded", views: ["3d"] }));
      await runFmcDoc({ action: "close", session: open.session, template: "", file: "", ops: [], dry_run: true, path: "", overwrite: false, detail_level: "fine", style: "shaded", views: ["3d"] });
    } else flexError = String(open.error ?? (open.reasons ?? []).join("; ") ?? "");
  }
  // F-061: a family the register hosts on a wall or ceiling face is placed in a throw-away project and its host moved
  const registerHostText = registerHost(cfg, family);
  const kind = hostTestKind(registerHostText);
  let hostTest: HostTestResult | null = null, hostTestError = "";
  if (kind) {
    try { hostTest = (await withRevitConnection((c) => c.sendRaw("fmc_family_host_test", { path: file, host: kind }, 180000))) as HostTestResult; }
    catch (e) { hostTestError = e instanceof Error ? e.message : String(e); }
  }
  const gate = gateA(family, recipe, { inspect: inspect.plan ?? null, inspectError, flex: flexResult as any, flexError, registerCategory: registerCategory(cfg, family),
    specCategory: specCategory(cfg, family), tokenCategories: tokenCategories(cfg), recordedSides: recordedSides(cfg, family, file),
    registerHost: registerHostText, hostTest, hostTestError });
  const result = { family, file, at: new Date().toISOString(), ...gate };
  try { fs.writeFileSync(file.replace(/\.rfa$/i, ".gate.json"), JSON.stringify(result, null, 2)); } catch { /* the gate still answers */ }
  return result;
}

function readDictionary(config: GuardConfig) {
  try { return parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { return null; }
}

/** What check and build both need from a recipe: its template and planes, the problems, the resolved family paths and the target. */
function prepareRecipe(recipe: Recipe, config: GuardConfig, dictionary: ReturnType<typeof readDictionary>) {
  const materials = recipe.ops.some((o) => o.op === "add_material") ? readDb(config) : undefined;
  const template = win.isAbsolute(recipe.template) ? recipe.template : win.join(config.family_template_dir, recipe.template);
  // F-038: the template's own planes (Left, Right, Exterior, Head…) aren't "not made earlier"; a sweep's path_planes
  // must be one of them or made earlier (no fixed geometry by accident)
  const planes = templatePlanes(template, expandEnv(config.reports_dir));
  const libraryRoots = (config.library_roots ?? []).map((r) => expandEnv(r));
  const { errors, notes } = splitProblems(opsProblems(recipe.ops, dictionary, win.dirname(expandEnv(config.family_staging_root)), materials,
    { libraryRoots, templatePlanes: planes.planes, template: win.basename(template) }));
  // F-061: a family the register hosts on a wall or ceiling face can't come from an unhosted template
  const hostProblem = hostTemplateProblem(recipe.family, win.basename(template), registerHost(config, recipe.family));
  if (hostProblem) notes.push(`${WARNING} ${hostProblem}`);
  // load_family paths are relative to the kit's family roots on this PC (the recipe works on any PC)
  // F-062: a skeleton op is sent as the ops it stands for
  const families = resolveFamilyPaths(expandSkeletons(recipe.ops), familyRoots(expandEnv(config.family_staging_root), libraryRoots), (f) => fs.existsSync(f));
  notes.push(...families.notes);
  const target = stagingPath(expandEnv(config.family_staging_root), recipe.family);
  return { template, planes, errors, notes, families, target, materials };
}

/** The recipes a batch names: recipe files, files holding an array of recipes (the chat's batch files), and a folder of either. */
function batchRecipes(args: FmcRecipeArgs): { recipes: Array<{ recipe: Recipe; file: string }>; problems: string[] } {
  const files = [...args.recipe_files];
  if (args.folder.trim()) {
    const dir = args.folder.trim();
    if (!fs.existsSync(dir)) return { recipes: [], problems: [`Folder not found: ${dir}`] };
    for (const f of fs.readdirSync(dir).sort()) if (/\.json$/i.test(f) && !/^batch_log|\.gate\.json$/i.test(f)) files.push(win.join(dir, f));
  }
  const recipes: Array<{ recipe: Recipe; file: string }> = [];
  const problems: string[] = [];
  for (const file of files) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (e) { problems.push(`${win.basename(file)}: not readable JSON`); continue; }
    for (const one of Array.isArray(raw) ? raw : [raw]) {
      const parsed = parseRecipe(JSON.stringify(one));
      if (parsed.recipe) recipes.push({ recipe: parsed.recipe, file });
      else problems.push(`${win.basename(file)}${Array.isArray(raw) ? ` (${String((one as { family?: string })?.family ?? "?")})` : ""}: ${parsed.problems.join("; ")}`);
    }
  }
  return { recipes, problems };
}

function batchFolder(config: GuardConfig) { return win.join(expandEnv(config.family_staging_root), "_Batch"); }

/**
 * F-063 (QG4): fmc_recipe batch builds many recipes in one Revit job. Every recipe is checked first (the same checks as
 * fmc_recipe check); families already staged from the same recipe revision with Gate A passed are skipped unless rebuild
 * names them. A dry run shows the plan. The real run writes a manifest, and the add-in builds them one after another
 * (apply, flex, archive the old staged file, save with the recipe), one line per family in _Batch\<batch>.jsonl.
 * batch_status reads that file; batch_gate runs Gate A on what was built, as many as fit in one call each time.
 */
async function runBatchAction(args: FmcRecipeArgs, config: GuardConfig, dry: boolean) {
  const folder = batchFolder(config);
  if (args.action === "batch_status" || args.action === "batch_gate") {
    if (!args.batch.trim()) return reply({ refused: true, reasons: ["Name the batch (B-yyyymmdd-hhmm): fmc_recipe batch gives it"] }, true);
    const resultsFile = win.join(folder, `${args.batch.trim()}.jsonl`);
    const r = readBatchResults(resultsFile);
    if (!r.lines.length) return reply({ refused: true, reasons: [`No results yet in ${resultsFile}: the batch hasn't built a family, or the name is wrong (fmc_job status shows the job)`] }, true);
    if (args.action === "batch_status")
      return reply({ batch: args.batch, results_file: resultsFile, built: r.built, failed: r.failed, gated: r.gated, gate_passed: r.passed,
        failures: r.lines.filter((l) => l.ok === false).map((l) => `${l.family}: ${l.error}`).slice(0, 40),
        gate_fails: r.lines.filter((l) => l.gate === "Fail").map((l) => `${l.family}: ${(l.gate_fails ?? []).join("; ")}`).slice(0, 40),
        next: r.gated < r.built ? `fmc_recipe batch_gate batch=${args.batch} runs Gate A on the ${r.built - r.gated} built and not yet gated` : "Every built family is gated" });
    // batch_gate: as many as fit in this call (the client cuts a call at about a minute); run it again for the rest
    const todo = r.lines.filter((l) => l.ok === true && !l.gate && typeof l.saved === "string");
    const soft = softTimeoutMs();
    const budget = soft > 0 ? Math.max(soft - 15000, 10000) : Infinity;
    const started = Date.now();
    const done: string[] = [];
    for (const l of todo) {
      if (Date.now() - started > budget) break;
      const g = await runGate(String(l.saved), config);
      const fails = g.lines.filter((x) => x.state === "Fail").map((x) => `${x.check}: ${x.detail}`.slice(0, 200));
      fs.appendFileSync(resultsFile, JSON.stringify({ family: l.family, gate: g.verdict, gate_fails: fails, gate_at: localIso(new Date().toISOString()) }) + "\n");
      done.push(`${l.family}: ${g.verdict}`);
    }
    const left = todo.length - done.length;
    log(config, "recipe_batch_gate", false, resultsFile, `${done.length} gated`, `${left} left`);
    return reply({ batch: args.batch, gated_now: done, left, next: left ? `Run batch_gate again for the ${left} left` : "Every built family is gated: batch_status shows the totals" });
  }

  // batch: check every recipe, plan, and (not a dry run) build them in one Revit job
  const { recipes, problems } = batchRecipes(args);
  if (!recipes.length) return reply({ refused: true, reasons: problems.length ? problems : ["Give recipe_files or a folder of recipes"] }, true);
  const dictionary = readDictionary(config);
  const invalid: string[] = [...problems];
  const ready = new Map<string, { recipe: Recipe; prep: ReturnType<typeof prepareRecipe>; revision: string }>();
  for (const { recipe } of recipes) {
    const prep = prepareRecipe(recipe, config, dictionary);
    const stop = [...prep.errors, ...(roleOf(recipe.family) ? [] : [`${recipe.family} doesn't follow FMC_<Role>_<Token>_<Description>`]),
      ...(checkWritePath(prep.target, config).ok ? [] : checkWritePath(prep.target, config).reasons)];
    if (stop.length) { invalid.push(`${recipe.family}: ${stop.slice(0, 3).join(" | ")}`); continue; }
    ready.set(recipe.family, { recipe, prep, revision: recipeRevision(recipe) });
  }
  const staged = (target: string) => {
    if (!fs.existsSync(target)) return { exists: false };
    let revision: string | null = null, verdict: string | null = null;
    try { const r = parseRecipe(fs.readFileSync(target.replace(/\.rfa$/i, ".recipe.json"), "utf8")).recipe; revision = r ? recipeRevision(r) : null; } catch { /* no recipe beside it */ }
    try { verdict = JSON.parse(fs.readFileSync(target.replace(/\.rfa$/i, ".gate.json"), "utf8")).verdict ?? null; } catch { /* never gated */ }
    return { exists: true, revision, verdict };
  };
  const plan = planBatch([...ready.values()].map((x) => ({ family: x.recipe.family, revision: x.revision, staged: staged(x.prep.target) })), args.rebuild);
  const build = args.max > 0 ? plan.build.slice(0, args.max) : plan.build;
  const id = args.batch.trim() || batchId();
  const resultsFile = win.join(folder, `${id}.jsonl`);
  const ops = build.reduce((t, f) => t + ready.get(f)!.recipe.ops.length, 0);
  const summary = { batch: id, recipes: recipes.length, to_build: build.length, skipped: plan.skip.length, invalid: invalid.length, ops,
    build: build.slice(0, 60), skip: plan.skip.slice(0, 30), invalid_detail: invalid.slice(0, 30), results_file: resultsFile };
  if (dry) return reply({ dry_run: true, ...summary, next: build.length ? "Run again with dry_run=false to build them in one Revit job" : "Nothing to build" });
  if (!build.length) return reply({ ...summary, next: "Nothing to build: every recipe is staged and passed, or invalid" });
  if (!checkWritePath(resultsFile, config, { checkName: false }).ok) return reply({ refused: true, reasons: checkWritePath(resultsFile, config, { checkName: false }).reasons }, true);

  // the manifest: every item with its ops resolved the way fmc_doc apply resolves them (family paths, kit materials)
  const items = build.map((family) => {
    const { recipe, prep, revision } = ready.get(family)!;
    const resolved = prep.families.ops.map((o) => {
      if (o.op !== "add_material" || !prep.materials) return o;
      const m = prep.materials.materials.find((x) => x.name === o.name);
      return m ? { ...o, material: resolveMaterial(m, expandEnv(config.materials_file), (f) => fs.existsSync(f)).material } : o;
    });
    return { family, revision, template: prep.template, target: prep.target, archive_dir: win.join(win.dirname(prep.target), "_Archive"),
      ops: resolved, follow: followParams(recipe), recipe };
  });
  fs.mkdirSync(folder, { recursive: true });
  const manifest = win.join(expandEnv(config.reports_dir), "Batches", `${id}.json`);
  fs.mkdirSync(win.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ batch: id, made: localIso(new Date().toISOString()), items }));
  log(config, "recipe_batch", false, resultsFile, "sent", `${build.length} families, ${ops} ops`);
  try {
    const r = await withRevitConnection((c) => c.sendRaw("fmc_recipe_batch", { items_file: manifest, results_file: resultsFile,
      shared_parameter_file: expandEnv(config.shared_parameter_file), max_seconds: args.seconds, max_backups: config.max_backups ?? 3 }, 12 * 60 * 60 * 1000));
    return reply({ ...summary, revit: r, next: `fmc_recipe batch_gate batch=${id} runs Gate A on what was built (run it until nothing is left)` });
  } catch (e) {
    if (e instanceof JobStillRunning)
      return reply({ ...summary, running: true, job: e.job, next: `It builds in Revit now (job ${e.job}). fmc_recipe batch_status batch=${id} shows progress; ` +
        `fmc_job status follows the job; when it ends, fmc_recipe batch_gate batch=${id}` });
    throw e;
  }
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
      const r = await cleanupBackground(dry, expandEnv(config.reports_dir), docCall, idleLimit(config));
      if (!dry) log(config, "recipe_cleanup", false, "background documents", r.isError ? "error" : "done", JSON.stringify((r.body as any).closed ?? r.body).slice(0, 400));
      return reply(r.body, r.isError);
    }

    if (args.action === "batch" || args.action === "batch_status" || args.action === "batch_gate") return await runBatchAction(args, config, dry);

    // F-057: a recipe sent inline (from a chat with no folder on this PC) is kept in the reports folder and used like a file
    let recipeFile = args.recipe_file.trim();
    if (args.recipe && Object.keys(args.recipe).length) {
      const fam = String((args.recipe as Record<string, unknown>).family ?? "");
      if (!/^FMC_[A-Za-z0-9]+_[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(fam)) return reply({ refused: true, reasons: [`The inline recipe's family "${fam}" doesn't follow FMC_<Role>_<Token>_<Description>`] }, true);
      const dir = win.join(expandEnv(config.reports_dir), "Recipes");
      fs.mkdirSync(dir, { recursive: true });
      recipeFile = win.join(dir, `${fam}.recipe.json`);
      fs.writeFileSync(recipeFile, JSON.stringify(args.recipe, null, 2));
    }
    const { recipe, problems } = readRecipe(recipeFile);
    if (!recipe) return reply({ refused: true, reasons: problems }, true);
    const { template, planes, errors, notes, families, target } = prepareRecipe(recipe, config, readDictionary(config));
    const sources = Object.fromEntries(["verified", "EA", "assumed", "pending"].map((s) => [s, Object.entries(recipe.values).filter(([, v]) => v.source_status === s).map(([k]) => k)]));
    const shown = dropTemplateNotes(notes, planes.planes);
    if (args.action === "check") {
      const envelope = requestBytes("fmc_doc_apply", applyEnvelope("00000000", expandEnv(config.shared_parameter_file)));
      const bytes = envelope + Buffer.byteLength(JSON.stringify(families.ops), "utf8");
      const chunks = planChunks(families.ops, args.chunk_size, CHUNK_BYTES, envelope);
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
      recipeFile, template, target, dry, overwrite: args.overwrite, stepwise: args.stepwise, chunkSize: args.chunk_size,
      resume: args.resume, reportsDir: expandEnv(config.reports_dir), sharedParameterFile: expandEnv(config.shared_parameter_file),
      notes: shown.notes, sources, ops: families.ops, follow: followParams(recipe),
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
