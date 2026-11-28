import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { exportFamily, kitMaterials, paramList, scriptFiles, type KitMaterial, type MappingReport } from "../hub/archicad.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_ARCHICAD_DESCRIPTION =
  "Formcraft engineering hub: ArchiCAD GDL objects from Revit families (docs/PLAN_ARCHICAD.md, AC1 build, the generator step). " +
  "Reads a family's recipe (recipe_file, fmc-recipe/0.1) or the fmc_doc report of a family opened in staging (report_file: fmc_doc open, then report, saved as JSON); " +
  "an .rfa is never opened here (family_file is refused with the way to get its recipe or report). " +
  "map: the dry run, nothing written: each parameter (Revit type → GDL type and default), each solid (extrusion, sweep, blend, revolution, void, array → BLOCK, EXTRUDE, TUBE, RULED, REVOLVE, GROUP/SUBGROUP, or unsupported with the reason), " +
  "nested families, connectors, symbolic lines, materials (kit surfaces inline), subcategories and types, with counts. " +
  "export: the same, plus the GDL library part as XML for LP_XMLConverter xml2libpart (master, 2D, 3D, parameter and interface scripts), the scripts as .gdl, " +
  "the parameter list and the mapping report, into out_dir\\<family>\\ (default <family_staging_root>\\_ArchiCAD\\src); a dry run (the default) lists the files and writes nothing. " +
  "Never next to the source file, only inside the guard's write folders. LP_XMLConverter and ArchiCAD are never run: converter_path (off by default) only writes a build_gsm.cmd to run by hand. " +
  "Geometry is frozen at the default type's size; types become a fmcType list that sets the mapped parameters.";

export const FMC_ARCHICAD_SHAPE = {
  action: z.enum(["map", "export"]),
  recipe_file: z.string().optional().default("").describe("The family's recipe (.recipe.json, fmc-recipe/0.1)"),
  report_file: z.string().optional().default("").describe("An fmc_doc report of the family (JSON saved from fmc_doc open/report): boxes only"),
  family_file: z.string().optional().default("").describe("An .rfa: refused here (Revit reads it); the reply says how to get its recipe or report"),
  materials_file: z.string().optional().default("").describe("Kit materials (FMC_Materials.json); default the guard's materials_file"),
  out_dir: z.string().optional().default("").describe("export: where the object folder goes; default <family_staging_root>\\_ArchiCAD\\src"),
  dry_run: z.boolean().optional().default(true).describe("export: a dry run lists the files and writes nothing"),
  converter_path: z.string().optional().default("").describe("export: LP_XMLConverter.exe, only written into build_gsm.cmd (never run). Empty: no build script"),
  full: z.boolean().optional().default(false).describe("map: every row; default only the summary and the rows that aren't fully mapped"),
};

export type FmcArchicadArgs = z.infer<z.ZodObject<typeof FMC_ARCHICAD_SHAPE>>;

export interface ArchicadIo { config?: GuardConfig }

function readJson(file: string): { json?: Record<string, any>; error?: string } {
  try { return { json: JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) }; }
  catch (e) { return { error: `${file}: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** Only the rows a person has to look at, unless full. */
function trimmed(r: MappingReport, full: boolean) {
  if (full) return r;
  const notMapped = <T extends { status: string }>(xs: T[]) => xs.filter((x) => x.status !== "mapped");
  return { ...r, parameters: notMapped(r.parameters), geometry: notMapped(r.geometry), materials: notMapped(r.materials),
    subcategories: notMapped(r.subcategories), other: notMapped(r.other), rows: "only rows not fully mapped; full: true lists every row" };
}

const safeFolder = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").trim() || "Unnamed";
const sameDir = (a: string, b: string) => win.normalize(a).replace(/[\\/]+$/, "").toLowerCase() === win.normalize(b).replace(/[\\/]+$/, "").toLowerCase();

export async function runFmcArchicad(args: FmcArchicadArgs, io: ArchicadIo = {}) {
  const config = io.config ?? loadConfig().config;
  if (args.family_file) {
    return reply({ refused: true, reasons: [
      `${args.family_file}: fmc_archicad doesn't open .rfa files (that needs Revit, and Revit stays the person's).`,
      "Pass recipe_file (the family's recipe in the kit), or open a staging copy with fmc_doc open, run fmc_doc report, save that JSON and pass it as report_file (boxes only).",
    ] }, true);
  }
  const sources = [args.recipe_file, args.report_file].filter(Boolean);
  if (sources.length !== 1) return reply({ refused: true, reasons: ["Give one source: recipe_file or report_file"] }, true);
  const sourceFile = sources[0];
  const read = readJson(sourceFile);
  if (!read.json) return reply({ error: read.error }, true);
  if (args.recipe_file && !Array.isArray(read.json.ops)) return reply({ error: `${sourceFile} isn't a recipe (no ops)` }, true);

  let kit = new Map<string, KitMaterial>();
  const matFile = args.materials_file || expandEnv(config.materials_file ?? "");
  let materials = "none: kit surfaces get grey stand-ins";
  if (matFile && fs.existsSync(matFile)) {
    const m = readJson(matFile);
    if (m.json) { kit = kitMaterials(m.json); materials = `${matFile} (${kit.size} materials)`; }
    else materials = `unreadable: ${m.error}`;
  } else if (matFile) materials = `not found at ${matFile}: kit surfaces get grey stand-ins`;

  const { obj, xml, problems } = exportFamily(args.recipe_file ? { recipe: read.json } : { report: read.json }, kit);
  const head = { family: obj.family, source: sourceFile, materials, gdl_guid: obj.guid, xml_check: problems.length ? problems : "ok (structure; LP_XMLConverter not run)" };

  if (args.action === "map") {
    log(config, "fmc_archicad map", true, sourceFile, problems.length ? "problems" : "ok", JSON.stringify(obj.report.summary));
    return reply({ dry_run: true, ...head, report: trimmed(obj.report, args.full), next: "fmc_archicad export (dry run first) writes the GDL XML, scripts, parameter list and this report" });
  }

  // export
  const root = args.out_dir || (config.family_staging_root ? path.join(expandEnv(config.family_staging_root), "_ArchiCAD", "src") : "");
  if (!root) return reply({ refused: true, reasons: ["No out_dir and no family_staging_root in the guard config"] }, true);
  const dir = path.join(root, safeFolder(obj.family));
  const srcDir = path.dirname(path.resolve(sourceFile));
  if (sameDir(root, srcDir) || sameDir(dir, srcDir)) return reply({ refused: true, reasons: [`out_dir is the source file's own folder (${srcDir}): GDL output never goes next to the source`] }, true);
  const files: Record<string, string> = {
    [path.join(dir, `${obj.family}.xml`)]: xml,
    [path.join(dir, `${obj.family}.params.json`)]: JSON.stringify({ family: obj.family, gdl_guid: obj.guid, parameters: paramList(obj) }, null, 2),
    [path.join(dir, `${obj.family}.mapping.json`)]: JSON.stringify({ ...head, report: obj.report }, null, 2),
  };
  for (const [n, body] of Object.entries(scriptFiles(obj))) files[path.join(dir, "scripts", n)] = body;
  if (args.converter_path) {
    const gsm = path.join(dir, `${obj.family}.gsm`);
    files[path.join(dir, "build_gsm.cmd")] = [
      "@echo off", "rem Formcraft: compile this GDL object by hand (fmc_archicad never runs the converter).",
      `"${args.converter_path}" xml2libpart "%~dp0${obj.family}.xml" "%~dp0${obj.family}.gsm"`, "",
    ].join("\r\n");
    head.xml_check = problems.length ? problems : `ok (structure); compile with build_gsm.cmd → ${gsm}`;
  }
  const verdicts = Object.keys(files).map((f) => ({ f, v: checkWritePath(f, config, { checkName: false }) })).filter((x) => !x.v.ok);
  if (verdicts.length) {
    log(config, "fmc_archicad export", args.dry_run, dir, "refused", verdicts[0].v.reasons.join("; "));
    return reply({ refused: true, reasons: [...new Set(verdicts.flatMap((x) => x.v.reasons))], ...head, report: trimmed(obj.report, false) }, true);
  }
  if (problems.length) return reply({ refused: true, reasons: ["The generated XML failed its structure check: nothing written", ...problems], ...head }, true);
  if (args.dry_run) {
    log(config, "fmc_archicad export", true, dir, "dry run", `${Object.keys(files).length} files`);
    return reply({ dry_run: true, ...head, would_write: Object.keys(files), report: trimmed(obj.report, args.full), next: "Run again with dry_run=false" });
  }
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, "utf8");
  }
  log(config, "fmc_archicad export", false, dir, "written", `${Object.keys(files).length} files`);
  return reply({ written: Object.keys(files), ...head, summary: obj.report.summary, size_mm: obj.report.size_mm,
    next: args.converter_path ? "Run build_gsm.cmd by hand on a PC with ArchiCAD, then check the object in ArchiCAD" : "Compile with LP_XMLConverter xml2libpart on a PC with ArchiCAD (not run by this tool)" });
}

export function registerFmcArchicadTool(server: McpServer) {
  server.tool("fmc_archicad", FMC_ARCHICAD_DESCRIPTION, FMC_ARCHICAD_SHAPE, (args) => runFmcArchicad(args));
}
