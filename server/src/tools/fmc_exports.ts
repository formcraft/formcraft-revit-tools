import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, expandEnv, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { projectRootOf } from "../fmc/schedule_data.js";
import {
  DEFAULT_SETUPS, EXPORT_FORMATS, exportGate, formatOf, outputName, parseSetups, runId, targetFolder, verifyOutput,
  type ExportFormat, type ExportSetup, type Target, type Verified,
} from "../fmc/exports.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_EXPORTS_DESCRIPTION =
  "Formcraft exports (GAP-04): IFC4, DWG, NWC and gbXML from the kit's export setups (03_Master_Data\\FMC_Export_Setups.json, " +
  "or built-in defaults: IFC4 Reference View with the kit's 07_IFC_IDS property sets, the FMC_DWG setup, NWC in shared " +
  "coordinates, gbXML), with every output verified (IFC STEP header and IFC4 schema, DWG AC10xx, gbXML root, NWC binary). " +
  "setups (read-only, no Revit) lists them. plan (read-only) checks the model (views, the DWG setup, the Navisworks " +
  "exporter) and returns the files and the folder. export writes only into the project's 02_Shared (target shared) or " +
  "03_Published (target published); both are CDE gates, so a real export needs dry_run=false, confirm=true and the named " +
  "approver. dry_run defaults to true. Files arrive in a hidden folder inside the target, are verified, and only then " +
  "moved into place; an existing file is kept unless overwrite=true, which archives it to _Archive first. verify " +
  "(read-only) checks files already in a folder. The model is not changed (IFC export is rolled back).";

export const FMC_EXPORTS_SHAPE = {
  action: z.enum(["setups", "plan", "export", "verify"]),
  document: z.string().optional().default("").describe("The document title or path (plan, export)"),
  formats: z.array(z.enum(EXPORT_FORMATS)).optional().default(["ifc"]).describe("Which exports, by setup name: ifc, dwg, nwc, gbxml"),
  views: z.array(z.string()).optional().default([]).describe("DWG: the views or sheets (names or ids); IFC/NWC: one 3D view to limit to"),
  target: z.enum(["shared", "published"]).optional().default("shared"),
  subfolder: z.string().optional().default("").describe("A plain folder name inside the target"),
  kit_folder: z.string().optional().default("").describe("The kit folder; default from specs_path in fmc_guard.json"),
  suffix: z.string().optional().default(""),
  overwrite: z.boolean().optional().default(false),
  approver: z.string().optional().default("").describe("export: the person who approves writing into 02_Shared / 03_Published"),
  confirm: z.boolean().optional().default(false),
  folder: z.string().optional().default("").describe("verify: the folder to check"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcExportsArgs = z.infer<z.ZodObject<typeof FMC_EXPORTS_SHAPE>>;

export interface ExportsIo {
  check?: (body: Record<string, unknown>) => Promise<unknown>;
  run?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  now?: Date;
}

const base = { tool: "fmc_exports" };
const refused = (code: string, message: string, extra: object = {}) => reply({ ...base, refused: true, code, message, ...extra }, true);

function kitRoot(args: FmcExportsArgs, cfg: GuardConfig): string {
  if (args.kit_folder.trim()) return expandEnv(args.kit_folder.trim());
  // specs_path is <kit>\03_Master_Data\FMC_Family_Specs.json
  return win.dirname(win.dirname(expandEnv(cfg.specs_path)));
}

export function loadSetups(kit: string): { setups: Record<string, ExportSetup>; source: string; problems: string[]; warnings: string[] } {
  const file = win.join(kit, "03_Master_Data", "FMC_Export_Setups.json");
  if (!fs.existsSync(file)) return { setups: DEFAULT_SETUPS, source: "built-in", problems: [], warnings: [`The kit has no ${file}; built-in setups are used (a kit change request)`] };
  try {
    const r = parseSetups(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
    return { setups: { ...DEFAULT_SETUPS, ...r.setups }, source: file, problems: r.problems, warnings: [] };
  } catch (e) {
    return { setups: {}, source: file, problems: [`${file}: ${e instanceof Error ? e.message : String(e)}`], warnings: [] };
  }
}

function head(file: string, n = 65536): Buffer {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(n); const read = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, read); } finally { fs.closeSync(fd); }
}

export function verifyFile(file: string, setup?: ExportSetup): Verified {
  const format = formatOf(file);
  if (!format) return { file, format: "ifc", ok: false, size: 0, reason: "not an export format (.ifc, .dwg, .nwc, .xml)" };
  if (!fs.existsSync(file)) return { file, format, ok: false, size: 0, reason: "missing" };
  return verifyOutput(file, format, head(file), fs.statSync(file).size, setup);
}

function writeRecord(cfg: GuardConfig, run: string, record: object): string {
  try {
    const dir = win.join(expandEnv(cfg.reports_dir), "exports");
    fs.mkdirSync(dir, { recursive: true });
    const f = win.join(dir, `FMC_Export_${run}.json`);
    fs.writeFileSync(f, JSON.stringify(record, null, 2));
    return f;
  } catch { return ""; }
}

export async function runFmcExports(args: FmcExportsArgs, io: ExportsIo = {}) {
  const env = io.env ?? process.env;
  try {
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const cfg = loaded.config;
    const kit = kitRoot(args, cfg);
    const setups = loadSetups(kit);

    if (args.action === "setups") return reply({ ...base, action: "setups", read_only: true, kit, ...setups });

    if (args.action === "verify") {
      const folder = expandEnv(args.folder.trim());
      if (!folder || !fs.existsSync(folder)) return refused("FMC-EXPORTS-FOLDER", `verify needs an existing folder: ${folder || "(none)"}`);
      const files = fs.readdirSync(folder).filter((f) => formatOf(f)).map((f) => verifyFile(win.join(folder, f)));
      return reply({ ...base, action: "verify", read_only: true, folder, files, ok: files.every((f) => f.ok) });
    }

    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED", "fmc_exports needs document (a title or full path).");
    if (setups.problems.length) return refused("FMC-EXPORTS-SETUPS", setups.problems.join(" | "));
    const chosen: Array<{ name: ExportFormat; setup: ExportSetup }> = [];
    for (const f of args.formats) {
      const s = setups.setups[f];
      if (!s) return refused("FMC-EXPORTS-SETUP", `No ${f} setup`);
      chosen.push({ name: f, setup: s });
    }
    if (args.formats.includes("dwg") && !args.views.length) return refused("FMC-EXPORTS-VIEWS", "DWG needs views (the views or sheets to export).");
    const psets = win.join(kit, (setups.setups.ifc as { psets_file?: string } | undefined)?.psets_file ?? "");
    const checkBody = { document, dry_run: true, exports: chosen.map((c) => c.setup), views: args.views, ifc_psets_file: fs.existsSync(psets) ? psets : "" };
    const check = (io.check ? await io.check(checkBody) : await withRevitConnection((c) => c.sendRaw("fmc_exports_run", checkBody, 120000))) as Record<string, unknown>;
    const title = String(check?.title ?? document);
    const docPath = String(check?.path ?? "");
    const root = projectRootOf(docPath);
    const tf = targetFolder(root, args.target as Target, args.subfolder);
    const problems = [...((check?.problems as string[]) ?? [])];
    if (tf.problem) problems.push(tf.problem);
    const planned = chosen.map((c) => ({ format: c.name, file: tf.folder ? win.join(tf.folder, outputName(title, c.name, args.suffix)) : "", exists: false }));
    for (const p of planned) p.exists = !!p.file && fs.existsSync(p.file);
    const dry = args.action === "plan" || args.dry_run !== false;
    const gate = exportGate({ dry_run: false, confirm: args.confirm, approver: args.approver, target: args.target as Target, folder: tf.folder, projectRoot: root, writeRoots: cfg.write_roots });
    const blocked = saveBlocked({ title, path: docPath }, cfg);
    if (blocked) gate.push(blocked);
    if (loaded.problem) gate.push(loaded.problem);
    const exists = planned.filter((p) => p.exists && !args.overwrite).map((p) => `${p.file} exists (overwrite=true archives it first)`);
    const summary = { ...base, action: args.action, document: title, kit, setups_source: setups.source, warnings: [...setups.warnings, ...((check?.warnings as string[]) ?? [])],
      target: args.target, folder: tf.folder, planned, checks: check?.checks ?? {}, problems, needs_for_real_run: [...gate, ...exists] };
    if (dry) return reply({ ...summary, dry_run: true, read_only: true, next: problems.length ? "Fix the problems first" : "Nothing was written. A real export needs dry_run=false, confirm=true and approver." }, problems.length > 0);
    if (problems.length) return reply({ ...summary, refused: true, code: "FMC-EXPORTS-CHECK", dry_run: false }, true);
    if (gate.length || exists.length) return reply({ ...summary, refused: true, code: "FMC-EXPORTS-GATE", dry_run: false }, true);

    // the real export: into a hidden arrival folder inside the target, verified, then moved into place
    const run = runId(io.now);
    const arrival = win.join(tf.folder, `.fmc_export_${run}`);
    fs.mkdirSync(arrival, { recursive: true });
    const runBody = { ...checkBody, dry_run: false, folder: arrival, names: Object.fromEntries(chosen.map((c) => [c.name, outputName(title, c.name, args.suffix).replace(/\.[a-z]+$/i, "")])) };
    let made: Record<string, unknown>;
    try {
      made = (io.run ? await io.run(runBody) : await withRevitConnection((c) => c.sendCommand("fmc_exports_run", runBody, 1800000))) as Record<string, unknown>;
    } catch (e) {
      fs.rmSync(arrival, { recursive: true, force: true });
      throw e;
    }
    const files = fs.readdirSync(arrival).filter((f) => formatOf(f));
    const verified = files.map((f) => verifyFile(win.join(arrival, f), chosen.find((c) => c.name === formatOf(f))?.setup));
    const missingFormats = chosen.filter((c) => !files.some((f) => formatOf(f) === c.name)).map((c) => c.name);
    const ok = verified.length > 0 && verified.every((v) => v.ok) && !missingFormats.length;
    if (!ok) {
      fs.rmSync(arrival, { recursive: true, force: true });
      const record = { run, ok: false, document: title, approver: args.approver, target: args.target, verified, missingFormats, revit: made };
      return reply({ ...summary, dry_run: false, ok: false, refused: true, code: "FMC-EXPORTS-VERIFY", verified, missing_formats: missingFormats, record: writeRecord(cfg, run, record),
        message: "An output failed its check, so nothing was moved into the target; the arrival folder was removed." }, true);
    }
    const moved: Array<{ file: string; archived?: string }> = [];
    const keptExisting: string[] = [];
    for (const f of files) {
      const to = win.join(tf.folder, f);
      let archived: string | undefined;
      if (fs.existsSync(to)) {
        if (!args.overwrite) { keptExisting.push(to); continue; }
        const dir = win.join(tf.folder, "_Archive");
        fs.mkdirSync(dir, { recursive: true });
        archived = win.join(dir, `${run}_${f}`);
        fs.renameSync(to, archived);
      }
      fs.renameSync(win.join(arrival, f), to);
      moved.push({ file: to, ...(archived ? { archived } : {}) });
    }
    fs.rmSync(arrival, { recursive: true, force: true });
    const finalVerified = verified.map((v) => ({ ...v, file: win.join(tf.folder, win.basename(v.file)) }));
    const record = { run, ok: true, document: title, path: docPath, approver: args.approver, target: args.target, folder: tf.folder, moved, kept_existing: keptExisting, verified: finalVerified };
    return reply({ ...summary, dry_run: false, ok: true, moved, kept_existing: keptExisting, verified: finalVerified, record: writeRecord(cfg, run, record) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-EXPORTS", message);
  }
}

export function registerFmcExportsTool(server: McpServer) {
  server.tool("fmc_exports", FMC_EXPORTS_DESCRIPTION, FMC_EXPORTS_SHAPE, async (args) => runFmcExports(args as FmcExportsArgs));
}
