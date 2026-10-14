import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, isInside, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { BrandPack, TemplateFacts, auditTemplate } from "../fmc/template.js";
import { readXlsxSheets } from "../fmc/xlsx.js";
import { BaseRecipe, LAYERS, Layer, baseRecipe, expectedNames, layerPayload, table } from "../fmc/templatekit.js";

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

export const FMC_TEMPLATE_DESCRIPTION =
  "Formcraft templates: audit reads a .rte (opened in the background if needed) and checks it against the kit: shared " +
    "parameters by GUID against FMC_SharedParameters.txt, view templates and filters, fonts against a brand pack, title " +
    "blocks, browser organisation, size, unused families and warnings (Must, Should, Advice). recipe (read-only) reads the " +
    "kit (FMC_Revit_Kit.xlsx and FMC_Master_Data.json) into the base template's layers, with every reading it had to make " +
    "listed. build applies the layers to a template in a staging folder (creating it from seed_path first if asked, " +
    "then optional role copies that never overwrite); it is a dry run unless dry_run is false. compare lists what the " +
    "template lacks against the recipe. brand sets a brand pack's " +
    "fonts on the text and dimension types of a template in a staging folder; sizes never change. brand is a dry run " +
    "unless dry_run is false; show the user the dry run first.";

export const FMC_TEMPLATE_SHAPE = {
  action: z.enum(["audit", "brand", "recipe", "build", "compare"]),
  template_path: z.string().describe("Absolute path of the .rte"),
  brand: z.object({ name: z.string(), main_font: z.string(), title_font: z.string().optional() }).optional()
    .describe("The brand pack (from the kit): fonts for text and dimension types"),
  dry_run: z.boolean().optional().default(true),
  kit_folder: z.string().optional().default("").describe("recipe, build, compare: the Formcraft kit folder"),
  layers: z.array(z.enum(LAYERS)).optional().default([]).describe("build: the layers to apply (default: all, in order)"),
  seed_path: z.string().optional().default("").describe("build: a Revit template to start from when template_path doesn't exist yet"),
  role_copies: z.boolean().optional().default(false).describe("build: copy the finished template to FMC_<Role>_Template_<version>.rte for each kit role, never overwriting"),
};

export type FmcTemplateArgs = z.infer<z.ZodObject<typeof FMC_TEMPLATE_SHAPE>>;

/** The kit's base recipe (rule 7: read from the kit every time, never stored in code). */
export function loadRecipe(kit: string): { recipe: BaseRecipe | null; problems: string[]; roles: string[] } {
  const xlsx = win.join(kit, "03_Master_Data", "FMC_Revit_Kit.xlsx");
  const master = win.join(kit, "03_Master_Data", "FMC_Master_Data.json");
  const missing = [xlsx, master].filter((f) => !fs.existsSync(f));
  if (!kit || missing.length) return { recipe: null, problems: missing.map((f) => `Not found: ${f}`), roles: [] };
  const sheets = readXlsxSheets(fs.readFileSync(xlsx));
  const data = JSON.parse(fs.readFileSync(master, "utf8").replace(/^﻿/, ""));
  let kitName = "FMC_Kit";
  try { const k = JSON.parse(fs.readFileSync(win.join(kit, "FMC_Kit.json"), "utf8")); kitName = `FMC_Kit ${k.kit ?? ""} ${k.revision ?? ""}`.replace(/\s+/g, " ").trim(); } catch { /* the name is cosmetic */ }
  const roles = [...new Set(table(sheets.get("Sheet_Register")).map((r) => r["Role"]).filter(Boolean))];
  return { recipe: baseRecipe(kitName, sheets, data), problems: [], roles };
}

async function runRecipeTools(args: FmcTemplateArgs, config: GuardConfig) {
  const { recipe, problems, roles } = loadRecipe(args.kit_folder.trim());
  if (!recipe) return reply({ refused: true, reasons: problems.length ? problems : ["Set kit_folder"] }, true);
  const counts = {
    parameters: recipe.params.length, text_types: recipe.graphics.text.length, line_patterns: recipe.graphics.lines.length,
    fill_patterns: recipe.graphics.fills.length, voltages: recipe.electrical.voltages.length, distribution_systems: recipe.electrical.systems.length,
    load_classifications: recipe.electrical.loads.length, piping_systems: recipe.systems.piping.length, duct_systems: recipe.systems.duct.length,
    filters: recipe.filters.length, view_templates: recipe.view_templates.length, qa_views: recipe.qa_views.length, schedules: recipe.schedules.length,
  };
  if (args.action === "recipe") return reply({ kit: recipe.kit, layers: LAYERS, counts, roles, readings: recipe.notes });

  const target = args.template_path.trim();
  if (win.extname(target).toLowerCase() !== ".rte") return reply({ refused: true, reasons: ["A template is a .rte file"] }, true);

  if (args.action === "compare") {
    if (!fs.existsSync(target)) return reply({ refused: true, reasons: [`Template not found: ${target}`] }, true);
    const have = await withRevitConnection((c) => c.sendRaw("fmc_template_names", { template_path: target }, 300000));
    const want = expectedNames(recipe) as Record<string, string[]>;
    const missing: Record<string, string[]> = {};
    for (const [kind, names] of Object.entries(want)) {
      const got = new Set(((have?.[kind] ?? []) as string[]));
      const lack = names.filter((n) => !got.has(n));
      if (lack.length) missing[kind] = lack;
    }
    const total = Object.values(missing).reduce((a, b) => a + b.length, 0);
    return reply({ template: target, matches: total === 0, missing, counts,
      next: total ? "build the layers that lack these names (staging only)" : "The template holds everything the kit's recipe names" });
  }

  // build: staging only (rule 2); created from a seed when it doesn't exist yet; every layer a dry run unless dry_run is false.
  const dry = args.dry_run !== false;
  const where = checkWritePath(target, config, { checkName: false });
  if (!where.ok) return reply({ refused: true, reasons: where.reasons }, true);
  const layers: Layer[] = args.layers.length ? args.layers : [...LAYERS];
  const steps: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(target)) {
    const seed = args.seed_path.trim();
    if (!seed || !fs.existsSync(seed)) return reply({ refused: true, reasons: [`${target} doesn't exist: give seed_path (a Revit template) to start it from`] }, true);
    if (dry) return reply({ dry_run: true, would: [`create ${win.basename(target)} from ${win.basename(seed)}`, ...layers.map((l) => `apply ${l}`)], counts,
      readings: recipe.notes, next: "Run again with dry_run=false" });
    const c = await withRevitConnection((x) => x.sendRaw("fmc_template_create", { seed_path: seed, template_path: target }, 300000));
    steps.push({ step: "create", ...c });
  }
  for (const layer of layers) {
    const payload = layerPayload(recipe, layer);
    let more = true, round = 0;
    const totals = { made: 0, updated: 0, skipped: 0, notes: [] as string[] };
    while (more && round < 12) {
      round++;
      const r = await withRevitConnection((x) => x.sendRaw("fmc_template_build", { template_path: target, layer, payload, dry_run: dry, seconds: 33 }, 120000));
      totals.made += r?.made ?? 0; totals.updated += r?.updated ?? 0; totals.skipped += r?.skipped ?? 0;
      totals.notes.push(...((r?.notes ?? []) as string[]));
      more = !!r?.more && !dry; // a dry run rolls back, so it can't carry on: it shows the first slice
      if (r?.more && dry) totals.notes.push("dry run shows the first slice only; the real run carries on until the layer is done");
    }
    steps.push({ step: layer, ...totals, rounds: round });
  }
  const copies: string[] = [];
  if (args.role_copies) {
    const m = /^FMC_Base_(Template_.+\.rte)$/i.exec(win.basename(target));
    if (!m) steps.push({ step: "role_copies", skipped: "role copies are made from a FMC_Base_Template_<version>.rte" });
    else for (const role of roles) {
      const copy = win.join(win.dirname(target), `FMC_${role}_${m[1]}`);
      if (fs.existsSync(copy)) { copies.push(`${win.basename(copy)}: exists, kept`); continue; }
      if (!checkWritePath(copy, config, { checkName: false }).ok) { copies.push(`${win.basename(copy)}: refused by the guard`); continue; }
      if (!dry) fs.copyFileSync(target, copy);
      copies.push(`${win.basename(copy)}: ${dry ? "would copy" : "copied"}`);
    }
  }
  log(config, "template_build", dry, target, "done", steps.map((s) => `${s.step}: ${s.made ?? ""}`).join(" | "));
  return reply({ dry_run: dry, template: target, steps, role_copies: copies, readings: recipe.notes,
    next: dry ? "Run again with dry_run=false to build; then compare, then audit" : "Run compare, then audit; publishing is a request to the BIM Manager" });
}

export async function runFmcTemplate(args: FmcTemplateArgs) {
  const { config, problem } = loadConfig();
  if (args.action === "recipe" || args.action === "build" || args.action === "compare") {
    try { return await runRecipeTools(args, config); }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(config, "template_" + args.action, args.dry_run !== false, args.template_path, "error", msg);
      return reply({ error: msg }, true);
    }
  }
  const target = args.template_path;
  const reasons: string[] = [];
  if (win.extname(target).toLowerCase() !== ".rte") reasons.push("A template is a .rte file");
  if (!fs.existsSync(target)) reasons.push(`Template not found: ${target}`);
  const dry = args.dry_run !== false;

  if (args.action === "audit") {
    const readable = [...config.template_roots, ...config.write_roots, ...config.library_roots];
    if (!readable.some((r) => isInside(target, r))) reasons.push(`Audits read templates in the template, library or write folders of fmc_guard.json`);
    if (reasons.length) return reply({ refused: true, reasons, config_problem: problem }, true);
    try {
      const facts = (await withRevitConnection((c) => c.sendRaw("fmc_template_audit", { template_path: target }, 300000))) as TemplateFacts;
      let kit = null;
      try { kit = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { kit = null; }
      const lines = auditTemplate(facts, kit, (args.brand as BrandPack) ?? null);
      log(config, "template_audit", false, target, "done", lines.filter((l) => l.severity !== "Pass").map((l) => `${l.area}: ${l.status}`).join(" | "));
      return reply({ audited: target, title: facts.title, lines });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(config, "template_audit", false, target, "error", msg);
      return reply({ error: msg }, true);
    }
  }

  // brand: changes a template, so only in a write root (a staging folder), never a released one.
  if (!args.brand) reasons.push("brand needs the brand pack (name, main_font, title_font)");
  reasons.push(...checkWritePath(target, config, { checkName: false }).reasons);
  if (reasons.length) {
    log(config, "template_brand", dry, target, "refused", reasons.join(" | "));
    return reply({ refused: true, reasons, config_problem: problem }, true);
  }
  try {
    const r = await withRevitConnection((c) => c.sendRaw("fmc_template_brand",
      { template_path: target, main_font: args.brand!.main_font, title_font: args.brand!.title_font ?? args.brand!.main_font, dry_run: dry }, 300000));
    if (!dry) log(config, "template_brand", false, target, "done", `${(r?.changes ?? []).length} types · ${args.brand!.name}`);
    return reply(dry ? { dry_run: true, would_change: r?.changes ?? [], next: "Run again with dry_run=false" } : { done: true, changed: r?.changes ?? [], saved: r?.saved });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "template_brand", dry, target, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcTemplateTool(server: McpServer) {
  server.tool("fmc_template", FMC_TEMPLATE_DESCRIPTION, FMC_TEMPLATE_SHAPE, (args) => runFmcTemplate(args));
}
