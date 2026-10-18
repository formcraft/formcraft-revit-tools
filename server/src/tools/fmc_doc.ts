import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { SessionRecord, buildReport, idleLimit, markStale, openProblems, readLedger as readDocLedger, saveProblems, writeLedger as writeDocLedger } from "../fmc/doc.js";
import { BRIDGE_LIMIT_BYTES, applyEnvelope, isNoAnswer, isStillQueued, progressPath, readProgress, requestBytes, stoppedAt } from "../fmc/recipebuild.js";
import { serverBuild } from "./fmc_selftest.js";
import { OP, familyRoots, opsProblems, resolveFamilyPaths, splitProblems } from "../fmc/ops.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { resolveMaterial } from "../fmc/materials.js";
import { readDb } from "./fmc_material.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, false, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** The sessions the server knows (each CLI call is its own process): source, opened, last used, ops applied (B1b, F-046). */
function readLedger(cfg: GuardConfig): Record<string, SessionRecord> { return readDocLedger(expandEnv(cfg.reports_dir)); }
function writeLedger(cfg: GuardConfig, l: Record<string, SessionRecord>) { writeDocLedger(expandEnv(cfg.reports_dir), l); }

/** The kit's manifest (FMC_Kit.json) beside the specs, for the build report. */
function kitManifest(cfg: GuardConfig): { kit?: string; revision?: string } {
  let dir = win.dirname(expandEnv(cfg.specs_path));
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(win.join(dir, "FMC_Kit.json"), "utf8").replace(/^﻿/, "")); } catch { dir = win.dirname(dir); }
  }
  return {};
}

export const FMC_DOC_DESCRIPTION =
  "Formcraft asset builder engine (plan B1), sessions. open: a background family from a family template (.rft) in the " +
    "template roots, or a family file in staging (_Staging, _ChainTests); returns a session id and what the document holds. " +
    "report: what an open session holds (category, parameters, types, reference planes, warnings, and each solid's name, kind, " +
    "subcategory, detail-level visibility and box in mm, each connector's domain, system, size, origin and facing, nested families " +
    "and the overall extents, F-056). " +
    "screenshot: PNGs of its 3D, front and plan views to the reports folder, each cropped to the family's own geometry, " +
    "at a detail level (coarse, medium, fine or all three) and style (shaded, hidden, wireframe, realistic), with reference planes, " +
    "levels and dimensions hidden (F-055). save: to an .rfa in the write roots under a name " +
    "the naming rules accept, with <name>.build.json beside it. close: discards unsaved changes. background (read-only): the " +
    "sessions Revit holds, which close may close, and other background family documents. list and background mark a " +
    "session idle longer than the guard's session_idle_hours (default 12) as stale; fmc_recipe cleanup closes stale and " +
    "left-over sessions without saving (dry run first), never a document in a Revit window or one the person opened. " +
    "Never a project or workshared model. flex: every type regenerated in turn, constraint errors per type (nothing kept); with follow, each size parameter is also moved from its lowest to its highest value and every named solid reports whether it moved with it. apply: a batch of named ops (set_category, " +
    "set_family_params, add_ref_plane, add_family_param, add_shared_param, set_formula, add_type, set_type_value, " +
    "add_dimension, extrusion and void_extrusion locked to reference planes, set_material_param, set_visibility, add_connector, link_connector_param; LOD 400: add_subcategory with line weights, set_subcategory, sweep and void_sweep with point or FMC_Profile_* profiles, revolution, blend, symbolic_lines (swings, opening lines, per view and detail level), lock_face, add_eq_dimension, load_family from the kit's 04_Families, place_nested with associated parameters; profile_lines: a closed loop of lines and 3-point arcs in a profile family; set_visible_param: a solid's Visible from a Yes/No parameter; add_material: a material from the kit's library with its textures, optionally as a Material parameter's value; recipe ops: set_default_size (the type's Width/Height before any plane, F-026), delete_template_element (template elements by kind/subcategory/name, never by id), array (copies shown by an Integer count, or linear), symbolic_lines with ends on planes, a labelled radius and per-leaf repeats, load_family shared: true for nested hardware); set_type_image: a product picture from 04_Families as the built-in Type Image of every type (shows in Type Properties, schedules and legends); each answers create, update or skip, so a second run changes nothing; a dry run unless dry_run is " +
    "false, and the dry run is the real run rolled back. Sizes in mm; shared parameters only from the kit's dictionary by GUID.";

export const FMC_DOC_SHAPE = {
  action: z.enum(["open", "report", "screenshot", "save", "close", "list", "apply", "flex", "background"]),
  ops: z.array(OP).optional().default([]).describe("apply: the batch, in order"),
  dry_run: z.boolean().optional().default(true).describe("apply: a dry run unless false"),
  template: z.string().optional().default("").describe("open: a family template (.rft) in the template roots"),
  file: z.string().optional().default("").describe("open: a family file (.rfa) in the library roots"),
  session: z.string().optional().default(""),
  path: z.string().optional().default("").describe("save: the target .rfa (inside the write roots, named by the rules)"),
  overwrite: z.boolean().optional().default(false).describe("save: replace an existing file (a person decided)"),
  follow: z.array(z.object({ param: z.string().min(1), low_mm: z.number(), high_mm: z.number(), stepped: z.boolean().optional() })).optional()
    .describe("flex: size parameters to move from low to high on one type, reporting which named solids moved with each (Gate A)"),
  detail_level: z.enum(["coarse", "medium", "fine", "all"]).optional().default("fine").describe("screenshot: detail level; all gives one image per level"),
  style: z.enum(["shaded", "hidden", "wireframe", "realistic"]).optional().default("shaded").describe("screenshot: visual style"),
  views: z.array(z.enum(["3d", "front", "right", "plan"])).optional().default(["3d", "front", "plan"]).describe("screenshot: which views"),
};

export type FmcDocArgs = z.infer<z.ZodObject<typeof FMC_DOC_SHAPE>>;

export async function runFmcDoc(args: FmcDocArgs) {
  const { config } = loadConfig();
  try {
    const ledger = readLedger(config);
    const limit = idleLimit(config);
    // F-046: each session with its idle time; stale ones are for fmc_recipe cleanup (dry run first)
    if (args.action === "list") {
      const sessions = markStale(Object.values(ledger), new Date(), limit);
      const stale = sessions.filter((s) => s.stale).length;
      return reply({ sessions, stale, stale_after_hours: limit,
        next: stale ? `${stale} stale: fmc_doc background shows which Revit still holds; fmc_recipe cleanup closes them without saving (dry run first)` : undefined });
    }
    // F-040 (read-only): the sessions Revit holds (closable unless the person has the file open) and other background family documents
    if (args.action === "background") {
      const bg = await withRevitConnection((c) => c.sendRaw("fmc_doc_background", {}, 60000));
      const sessions = markStale((bg?.sessions ?? []) as Array<Record<string, any>>, new Date(), limit);
      return reply({ ...bg, sessions, stale: sessions.filter((s) => s.stale).length, stale_after_hours: limit });
    }

    if (args.action === "open") {
      const problems = openProblems(args, config);
      if (problems.length) return reply({ refused: true, reasons: problems }, true);
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_open", { template: args.template.trim(), file: args.file.trim() }, 120000));
      const id = String(r?.session ?? "");
      const at = new Date().toISOString();
      ledger[id] = { id, source: args.template.trim() || args.file.trim(), opened: at, used: at, ops: [] };
      writeLedger(config, ledger);
      log(config, "doc_open", ledger[id].source, "done", id);
      return reply({ session: id, document: r });
    }

    if (!args.session.trim()) return reply({ refused: true, reasons: [`${args.action} needs the session id from open`] }, true);
    const s = ledger[args.session.trim()] ?? { id: args.session.trim(), source: "", opened: "", ops: [] };
    // F-046: every call on a session counts as use (its idle time starts again)
    if (ledger[s.id] && args.action !== "close") { s.used = new Date().toISOString(); writeLedger(config, ledger); }

    if (args.action === "report") return reply({ session: s.id, document: await withRevitConnection((c) => c.sendRaw("fmc_doc_report", { session: s.id }, 60000)) });

    if (args.action === "screenshot") {
      const folder = win.join(expandEnv(config.reports_dir), "Screenshots");
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_screenshot", { session: s.id, folder, detail_level: args.detail_level, style: args.style, views: args.views }, 180000));
      return reply({ session: s.id, files: r?.files ?? [], extents_mm: r?.extents_mm ?? null, notes: r?.notes ?? [] });
    }

    if (args.action === "apply") {
      if (!args.ops.length) return reply({ refused: true, reasons: ["apply needs ops"] }, true);
      // load_family: a path relative to the kit's family roots is resolved on this PC before Revit sees it
      const libraryRoots = (config.library_roots ?? []).map((r) => expandEnv(r));
      const resolved = resolveFamilyPaths(args.ops, familyRoots(expandEnv(config.family_staging_root), libraryRoots), (f) => fs.existsSync(f));
      const bytes = requestBytes("fmc_doc_apply", { ...applyEnvelope(s.id, expandEnv(config.shared_parameter_file)), ops: resolved.ops });
      if (bytes > BRIDGE_LIMIT_BYTES) return reply({ refused: true, reasons: [`The batch is ${bytes} bytes; the Revit bridge reads ${BRIDGE_LIMIT_BYTES} per call, so Revit would never see it (F-029). Send fewer ops per apply, or build the recipe with fmc_recipe build stepwise: true`] }, true);
      let dictionary = null;
      try { dictionary = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { dictionary = null; }
      const materials = args.ops.some((o) => o.op === "add_material") ? readDb(config) : undefined;
      const { errors, notes } = splitProblems(opsProblems(args.ops, dictionary, win.dirname(expandEnv(config.family_staging_root)), materials, { libraryRoots }));
      if (errors.length) return reply({ refused: true, reasons: errors }, true);
      notes.push(...resolved.notes);
      // add_material: the server resolves the material from the kit's library (rule 7) and hands Revit its fields and
      // texture paths; Revit never looks a material up by itself.
      const ops = resolved.ops.map((o) => {
        if (o.op !== "add_material" || !materials) return o;
        const r = resolveMaterial(materials.materials.find((m) => m.name === o.name)!, expandEnv(config.materials_file), (f) => fs.existsSync(f));
        notes.push(...r.warnings);
        return { ...o, material: r.material };
      });
      const dry = args.dry_run !== false;
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_apply",
        { session: s.id, ops, dry_run: dry, shared_parameter_file: expandEnv(config.shared_parameter_file) }, 300000));
      if (!dry) {
        s.ops.push(...((r?.ops ?? []) as Array<{ op: string; name: string; result: string }>).map((o) => ({ op: o.op, name: o.name, result: o.result })));
        ledger[s.id] = s;
        writeLedger(config, ledger);
        log(config, "doc_apply", s.id, "done", `${r?.created ?? 0} created, ${r?.updated ?? 0} updated, ${r?.skipped ?? 0} skipped`);
      }
      return reply({ session: s.id, ...r, notes, next: dry ? "Run again with dry_run=false to apply" : "save writes it to staging with its build report" });
    }

    if (args.action === "flex") {
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_flex", { session: s.id, ...(args.follow?.length ? { follow: args.follow } : {}) }, 300000));
      return reply({ session: s.id, ...r, next: r?.ok ? "Every type regenerates" : "Fix the constraints the failing types name, then flex again" });
    }

    if (args.action === "close") {
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_close", { session: s.id }, 60000));
      delete ledger[s.id];
      writeLedger(config, ledger);
      return reply({ session: s.id, ...r });
    }

    // save
    const problems = saveProblems(args.path, config);
    if (problems.length) return reply({ refused: true, reasons: problems }, true);
    if (fs.existsSync(args.path) && !args.overwrite) return reply({ refused: true, reasons: [`${args.path} exists: a person decides to overwrite (overwrite: true)`] }, true);
    const saved = await withRevitConnection((c) => c.sendRaw("fmc_doc_save", { session: s.id, path: args.path.trim(), overwrite: args.overwrite, max_backups: config.max_backups }, 120000));
    const report = await withRevitConnection((c) => c.sendRaw("fmc_doc_report", { session: s.id }, 60000));
    const build = buildReport(s, args.path.trim(), report ?? {}, kitManifest(config), serverBuild().commit, new Date());
    const buildFile = args.path.trim().replace(/\.rfa$/i, ".build.json");
    fs.writeFileSync(buildFile, JSON.stringify(build, null, 2));
    log(config, "doc_save", args.path, "done", `${s.id} · ${build.ops.length} ops · ${build.ops_hash}`);
    return reply({ saved: saved?.saved ?? args.path, build_report: buildFile, build });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "doc_" + args.action, args.session || args.template || args.file, "error", msg);
    // F-029: when Revit didn't answer an apply, say where it got to (the add-in writes its progress before every op)
    if (args.action === "apply" && args.session.trim() && (isStillQueued(msg) || isNoAnswer(msg))) {
      const p = readProgress(progressPath(args.session.trim()));
      return reply({ error: msg, progress: p, stopped_at: stoppedAt(p, 0, new Date(Date.now() - 310000).toISOString()).text }, true);
    }
    return reply({ error: msg }, true);
  }
}

export function registerFmcDocTool(server: McpServer) {
  server.tool("fmc_doc", FMC_DOC_DESCRIPTION, FMC_DOC_SHAPE, (args) => runFmcDoc(args));
}
