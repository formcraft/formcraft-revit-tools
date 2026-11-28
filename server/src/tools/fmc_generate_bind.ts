import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters, type SpParam } from "../fmc/specs.js";
import { opsProblems, splitProblems } from "../fmc/ops.js";
import { RECIPE, stagingPath } from "../fmc/recipes.js";
import { DOOR_OPERATIONS, GB_TOOL, TEMPLATE_PLANES, WINDOW_OPERATIONS, planGenerateBind, planId, type GbInput } from "../fmc/generatebind.js";
import { SINKO_PARAMS } from "../fmc/sinkoparams.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_GENERATE_BIND_DESCRIPTION =
  "Formcraft generate-and-bind (doors and windows for a legend schedule). One call makes a door or window family from Metric Door.rft or " +
  "Metric Window.rft: frame (jambs, head, a sill rail for a window) and a leaf or glass pane, every face locked to labelled reference planes " +
  "so each type flexes; front and back legend geometry, the opening indication as plane-locked symbolic lines on the Legend Front " +
  "(exterior) and Legend Back (interior, dashed) subcategories, for legend components set to Elevation: Front and Elevation: Back; and " +
  `the eleven Sinko-style kit shared parameters bound as type parameters (${SINKO_PARAMS.map((p) => p.name).join(", ")}), GUIDs from the ` +
  "kit file only, the two area columns as formulas from the geometry. One type per row of types (width_mm, height_mm, type_mark); values " +
  "fill the parameter columns. dry_run defaults to true and writes nothing: it returns the recipe, the legend-schedule rows, the legend " +
  "placement that follows, the staging path and plan_id. A build is dry_run false with confirm true and the plan_id the dry run returned " +
  "(FMC-GB-DRY-RUN-FIRST otherwise); it runs the fmc_recipe build pipeline: a background family document, saved to " +
  "<family_staging_root>\\A\\<family>.rfa with its recipe, then Gate A. It never loads into a project, never touches an open model, " +
  "and release stays a person's act in the pane.";

const value = z.union([z.string(), z.number(), z.boolean()]);

export const FMC_GENERATE_BIND_SHAPE = {
  kind: z.enum(["door", "window"]),
  operation: z.enum([...DOOR_OPERATIONS, ...WINDOW_OPERATIONS]).optional()
    .describe("door: hinged_left (default) or hinged_right; window: casement_left (default), casement_right, top_hung, bottom_hung, sliding, fixed"),
  family: z.string().optional().default("").describe("FMC_A_Door_<Description> or FMC_A_Window_<Description>; built from description when empty"),
  description: z.string().optional().default(""),
  types: z.array(z.object({
    name: z.string().optional().describe("default WWWWxHHHH, e.g. 0900x2100"),
    width_mm: z.number().positive(),
    height_mm: z.number().positive(),
    type_mark: z.string().optional().describe("default D01, D02… or W01, W02…"),
    keynote: z.string().optional().describe("the type's keynote (Gate A wants one on every type)"),
    values: z.record(z.string(), value).optional().describe("this type's Sinko parameter values; win over values"),
  })).min(1).max(20),
  frame_width_mm: z.number().positive().optional().describe("face width of the frame; default 40 (door) or 50 (window)"),
  frame_depth_mm: z.number().positive().optional().default(100),
  leaf_thickness_mm: z.number().positive().optional().default(45).describe("door only"),
  sill_height_mm: z.number().min(0).optional().default(800).describe("window only: where the template's Sill sits when drawing (the instance Sill Height still rules)"),
  values: z.record(z.string(), value).optional().default({}).describe("Sinko parameter values for every type, by kit name"),
  source_status: z.enum(["verified", "EA", "assumed", "pending"]).optional().default("assumed"),
  source: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("build: a person said yes to the dry run"),
  plan_id: z.string().optional().default("").describe("build: the plan_id the dry run returned"),
  overwrite: z.boolean().optional().default(false).describe("build: replace a family already staged (a person decided)"),
};

export type FmcGenerateBindArgs = z.infer<z.ZodObject<typeof FMC_GENERATE_BIND_SHAPE>>;

export interface GenerateBindIo {
  guard?: GuardConfig;
  dictionary?: Map<string, SpParam> | null;
  exists?: (file: string) => boolean;
  /** The recipe build (default: fmc_recipe build with the inline recipe). */
  build?: (recipe: Record<string, unknown>, overwrite: boolean) => Promise<{ body: Record<string, unknown>; isError: boolean }>;
  log?: (action: string, dryRun: boolean, target: string, result: string, detail: string) => void;
}

function readDictionary(file: string): Map<string, SpParam> | null {
  try {
    // Revit writes shared parameter files as UTF-16 LE; the kit writes UTF-8. Read either.
    const buf = fs.readFileSync(file);
    return parseSharedParameters(buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8"));
  } catch {
    return null;
  }
}

function fileLog(cfg: GuardConfig) {
  return (action: string, dryRun: boolean, target: string, result: string, detail: string) => {
    try {
      const dir = expandEnv(cfg.reports_dir);
      fs.mkdirSync(dir, { recursive: true });
      const file = win.join(dir, "FMC_MCP_FileLog.csv");
      if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
      fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
    } catch {
      // logging must never block the work
    }
  };
}

async function recipeBuild(recipe: Record<string, unknown>, overwrite: boolean) {
  // Imported here so a dry run never loads the Revit build path.
  const { runFmcRecipe, FMC_RECIPE_SHAPE } = await import("./fmc_recipe.js");
  const args = z.object(FMC_RECIPE_SHAPE).parse({ action: "build", recipe, dry_run: false, overwrite });
  const r = await runFmcRecipe(args);
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(r.content[0].text); } catch { body = { text: r.content[0]?.text }; }
  return { body, isError: r.isError === true };
}

/** The whole tool: plan, checks, dry run (default, writes nothing), then the recipe build with the plan the person saw. */
export async function runFmcGenerateBind(args: FmcGenerateBindArgs, io: GenerateBindIo = {}) {
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig();
  const config = loaded.config;
  const dry = args.dry_run !== false;
  const log = io.log ?? fileLog(config);
  const exists = io.exists ?? fs.existsSync;
  try {
    if (loaded.problem) return reply({ tool: GB_TOOL, refused: true, code: "FMC-GB-CONFIG", reasons: [loaded.problem], wrote: false }, true);
    const kitFile = expandEnv(config.shared_parameter_file ?? "");
    const dictionary = io.dictionary !== undefined ? io.dictionary : readDictionary(kitFile);
    const input: GbInput = {
      kind: args.kind, operation: args.operation, family: args.family, description: args.description, types: args.types,
      frame_width_mm: args.frame_width_mm, frame_depth_mm: args.frame_depth_mm, leaf_thickness_mm: args.leaf_thickness_mm,
      sill_height_mm: args.sill_height_mm, values: args.values, source_status: args.source_status, source: args.source || undefined,
    };
    const plan = planGenerateBind(input, dictionary, kitFile);
    const reasons = [...plan.problems];
    const parsed = RECIPE.safeParse(plan.recipe);
    let notes = [...plan.notes];
    if (!parsed.success) reasons.push(...parsed.error.issues.slice(0, 10).map((i) => `[FMC-GB-RECIPE] ${i.path.join(".")}: ${i.message}`));
    else {
      const split = splitProblems(opsProblems(parsed.data.ops, dictionary, undefined, undefined, { templatePlanes: TEMPLATE_PLANES[args.kind], template: plan.template }));
      reasons.push(...split.errors.map((e) => `[FMC-GB-RECIPE] ${e}`));
      // the template's own planes (Left, Right, Head, Sill) always "may exist": only the other notes are worth showing
      notes = notes.concat(split.notes.filter((n) => !/"(Left|Right|Head|Sill|Ref\. Level)"/.test(n)));
    }
    const stagingRoot = expandEnv(config.family_staging_root ?? "");
    const target = stagingRoot ? stagingPath(stagingRoot, plan.family) : "";
    const where = target ? checkWritePath(target, config) : { ok: false, reasons: ["No family_staging_root in fmc_guard.json"] };
    if (/hebert hostels|a-0001/i.test(target)) where.reasons.push("A family is not written under a protected project folder (HEBERT HOSTELS, A-0001).");
    const already = target ? exists(target) : false;
    const id = planId(plan.recipe);
    const summary = {
      tool: GB_TOOL,
      family: plan.family,
      kind: plan.kind,
      operation: plan.operation,
      template: plan.template,
      staging_path: target,
      exists_in_staging: already,
      types: plan.legend_rows.map((r) => ({ type: r.type, type_mark: r.cells["Type Mark"], width_mm: r.cells.Width, height_mm: r.cells.Height })),
      shared_parameters: plan.sinko.map((p) => ({ name: p.name, guid: p.guid, datatype: p.datatype, binding: "type", group: p.group, ...(p.formula ? { formula: p.formula } : {}) })),
      legend_geometry: plan.legend_geometry,
      legend_schedule_rows: plan.legend_rows,
      legend_place: plan.legend_place,
      ops: (plan.recipe.ops as unknown[]).length,
      kit_file: kitFile,
      notes,
      saved: false, loaded_into_project: false, synced: false,
    };
    if (reasons.length) {
      // a dry run writes nothing, not even a log row
      if (!dry) log("generate_bind", false, target || plan.family, "refused", reasons.join(" | ").slice(0, 2000));
      return reply({ ...summary, refused: true, code: reasons[0].match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-GB", reasons, wrote: false, dry_run: true }, true);
    }
    if (dry) {
      const blockers = [...(where.ok ? [] : where.reasons), ...(already && !args.overwrite ? [`${target} exists: a person decides to overwrite (overwrite: true)`] : [])];
      return reply({
        ...summary,
        dry_run: true,
        wrote: false,
        plan_id: id,
        recipe: plan.recipe,
        build_blockers: blockers,
        next: blockers.length
          ? "Fix the build blockers, then run the dry run again."
          : `Show this plan. To build it: the same call with dry_run false, confirm true and plan_id ${id}.`,
      });
    }
    if (!args.confirm || args.plan_id.trim() !== id) {
      return reply({
        ...summary, refused: true, code: "FMC-GB-DRY-RUN-FIRST", wrote: false, dry_run: true,
        reasons: [args.plan_id.trim() && args.plan_id.trim() !== id
          ? `plan_id ${args.plan_id.trim()} is not this plan (${id}): the inputs changed since the dry run. Run the dry run again and show it.`
          : "A build needs confirm true and the plan_id from the dry run a person saw. Nothing was written."],
      }, true);
    }
    if (!where.ok) return reply({ ...summary, refused: true, code: "FMC-GB-PATH", reasons: where.reasons, wrote: false }, true);
    if (already && !args.overwrite) return reply({ ...summary, refused: true, code: "FMC-GB-EXISTS", reasons: [`${target} exists: a person decides to overwrite (overwrite: true)`], wrote: false }, true);
    const built = await (io.build ?? recipeBuild)(plan.recipe, args.overwrite);
    log("generate_bind", false, target, built.isError ? "failed" : "built", JSON.stringify(built.body).slice(0, 2000));
    return reply({ ...summary, dry_run: false, plan_id: id, build: built.body, saved: !built.isError && built.body.built !== false }, built.isError);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (!dry) log("generate_bind", false, args.family || args.kind, "error", msg);
    return reply({ tool: GB_TOOL, refused: true, code: "FMC-GB-ERROR", error: msg, wrote: false }, true);
  }
}

export function registerFmcGenerateBindTool(server: McpServer) {
  server.tool("fmc_generate_bind", FMC_GENERATE_BIND_DESCRIPTION, FMC_GENERATE_BIND_SHAPE, (args) => runFmcGenerateBind(args as FmcGenerateBindArgs));
}
