import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, isInside, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { BrandPack, TemplateFacts, TemplateRef, auditTemplate, roleCopyLine } from "../fmc/template.js";
import { csvRow, readRegisterFile } from "./fmc_sheets.js";
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
  "Formcraft templates: audit reads a .rte (opened in the background if needed) and checks it against the kit both ways: " +
    "shared parameters by GUID against FMC_SharedParameters.txt and the kit's project parameters (FMC_Master_Data.json) " +
    "missing from it, view templates and filters, stock view templates and schedules the kit doesn't add, fonts against " +
    "the brand pack, the kit's title blocks (FMC_TB_*, Family Register), legends the sheet register places, panel " +
    "schedule templates, materials (kit FMC_ materials, broken textures, unused, duplicates), role copies identical to " +
    "Base, browser organisation, size, unused families and warnings (Must, Should, Advice). A check that can't run says " +
    "Not checked and why, never Pass. recipe (read-only) reads the " +
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
  kit_folder: z.string().optional().default("").describe("recipe, build, compare, audit: the Formcraft kit folder (audit: default, the kit the guard's specs_path is in)"),
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

/** The kit folder: the one given, else the one the guard's specs_path sits in (<kit>\03_Master_Data\FMC_Family_Specs.json). */
export function kitFolderFor(given: string, config: GuardConfig): string {
  return given.trim() || win.dirname(win.dirname(expandEnv(config.specs_path)));
}

/**
 * LG_<Role>_* legends the sheet register places (its Placed column): the General ones (LG_Z_*) in every template, a
 * role's own (LG_E_*) in that role's template. The Base template is checked for the General ones.
 */
export function registerLegends(rows: string[][], role: string): string[] {
  const cPlaced = (rows[0] ?? []).map((h) => h.trim().toLowerCase()).indexOf("placed");
  if (cPlaced < 0) return [];
  const roles = new Set(["Z", role.toUpperCase()].filter(Boolean));
  const out = new Set<string>();
  for (const r of rows.slice(1))
    for (const m of (r[cPlaced] ?? "").matchAll(/\bLG_([A-Z]{1,2})_[A-Za-z0-9_]+/g)) if (roles.has(m[1])) out.add(m[0]);
  return [...out];
}

/**
 * F-044: everything the audit compares a template with, read from the kit now (rule 7). Each source that can't be read
 * leaves its lines Not checked, with the reason. The brand pack: the one passed, else the kit's only pack.
 */
export function loadAuditRef(kitFolder: string, config: GuardConfig, target: string, brandArg: BrandPack | null): { ref: TemplateRef; brand: BrandPack | null } {
  const md = path.join(kitFolder, "03_Master_Data");
  const problems: NonNullable<TemplateRef["problems"]> = {};
  const ref: TemplateRef = { problems, exists: (p) => fs.existsSync(p) };
  const role = /^FMC_([A-Z]{1,2})_Template_/i.exec(win.basename(target))?.[1]?.toUpperCase() ?? "";
  try {
    const data = JSON.parse(fs.readFileSync(path.join(md, "FMC_Master_Data.json"), "utf8").replace(/^﻿/, ""));
    ref.projectParameters = Object.keys(data?.params ?? {});
    if (!ref.projectParameters.length) { ref.projectParameters = null; problems.projectParameters = "FMC_Master_Data.json lists no params"; }
  } catch { problems.projectParameters = `Not readable: ${path.join(md, "FMC_Master_Data.json")}`; }
  try {
    const rows = fs.readFileSync(path.join(md, "FMC_Family_Register.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow);
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const [cFam, cCat, cPri] = ["family", "category", "priority"].map((h) => head.indexOf(h));
    ref.titleBlocks = rows.slice(1).filter((r) => (r[cCat] ?? "").trim().toLowerCase() === "title blocks").map((r) => ({ family: r[cFam].trim(), priority: (r[cPri] ?? "").trim() }));
    if (!ref.titleBlocks.length) { ref.titleBlocks = null; problems.titleBlocks = "The Family Register lists no Title Blocks"; }
  } catch { problems.titleBlocks = `Not readable: ${path.join(md, "FMC_Family_Register.csv")}`; }
  try {
    ref.legends = registerLegends(readRegisterFile(path.join(md, "FMC_Sheet_Register.csv")), role);
    if (!ref.legends.length) { ref.legends = null; problems.legends = "The sheet register places no LG_ legends"; }
  } catch { problems.legends = `Not readable: ${path.join(md, "FMC_Sheet_Register.csv")}`; }
  const materialsFile = fs.existsSync(expandEnv(config.materials_file)) ? expandEnv(config.materials_file) : path.join(kitFolder, "07_Materials", "FMC_Materials.json");
  try {
    ref.materials = (JSON.parse(fs.readFileSync(materialsFile, "utf8").replace(/^﻿/, "")).materials ?? []).map((m: { name?: string }) => String(m.name ?? "")).filter(Boolean);
    if (!ref.materials!.length) { ref.materials = null; problems.materials = `${materialsFile} lists no materials`; }
  } catch { problems.materials = `Not readable: ${materialsFile}`; }
  try {
    const sheets = readXlsxSheets(fs.readFileSync(path.join(md, "FMC_Revit_Kit.xlsx")));
    const col = (tab: string, c: string) => table(sheets.get(tab)).map((r) => r[c]).filter(Boolean);
    ref.panelTemplates = col("Panel_Schedules", "Template");
    ref.schedules = col("Schedules", "Name");
    ref.viewTemplates = col("View_Templates", "Name");
    if (!ref.panelTemplates.length) { ref.panelTemplates = null; problems.panelTemplates = "FMC_Revit_Kit.xlsx has no Panel_Schedules rows"; }
    if (!ref.schedules.length) { ref.schedules = null; problems.schedules = "FMC_Revit_Kit.xlsx has no Schedules rows"; }
    if (!ref.viewTemplates.length) ref.viewTemplates = null;
  } catch {
    const p = `Not readable: ${path.join(md, "FMC_Revit_Kit.xlsx")}`;
    problems.panelTemplates = p; problems.schedules = p;
  }
  let brand = brandArg;
  if (!brand) {
    const packsFile = path.join(kitFolder, "06_Templates", "FMC_BrandPacks.json");
    let packs: BrandPack[] = [];
    try { packs = (JSON.parse(fs.readFileSync(packsFile, "utf8").replace(/^﻿/, "")).packs ?? []).filter((p: BrandPack) => p?.name && p?.main_font); } catch { packs = []; }
    if (packs.length === 1) brand = packs[0];
    else ref.brandNote = packs.length
      ? `The kit has ${packs.length} brand packs (${packs.map((p) => p.name).join(", ")}): pass the one this template takes (brand)`
      : `The kit has no font pack (${packsFile} is missing or empty): fonts can't be checked; a kit change request`;
  }
  // Role copies: the .rte files beside it, compared byte for byte with Base
  try {
    const dir = win.dirname(target);
    const files = fs.readdirSync(dir).filter((f) => /^FMC_(Base|[A-Z]{1,2})_Template_.+\.rte$/i.test(f))
      .map((f) => ({ name: f, hash: createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex") }));
    ref.roleCopy = roleCopyLine(win.basename(target), files);
  } catch { ref.roleCopy = null; }
  return { ref, brand };
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
      // F-044: both ways against the kit; what can't be checked says why
      const kitFolder = kitFolderFor(args.kit_folder, config);
      const { ref, brand } = loadAuditRef(kitFolder, config, target, (args.brand as BrandPack) ?? null);
      const lines = auditTemplate(facts, kit, brand, ref);
      log(config, "template_audit", false, target, "done", lines.filter((l) => l.severity !== "Pass").map((l) => `${l.area}: ${l.status}`).join(" | "));
      return reply({ audited: target, title: facts.title, kit_folder: kitFolder, lines,
        not_checked: lines.filter((l) => l.status === "Not checked").length });
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
