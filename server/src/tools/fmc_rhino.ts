import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { processAlive } from "../fmc/navis.js";
import { exchangeRoot, writePackage } from "../hub/exchange.js";
import { PartFacts, RHINO_PART, RHINO_RULEBOOK_FILE, RhinoRulebook, familyNameProblem, isError, loadRhinoRulebook, partProblems, partSize, readRhinoState, rhinoCall, rhinoPaths, rhinoStateFile } from "../hub/rhino.js";
import { envelopeVerdict, materialCheck, openOnlySolids, recipeTwins, withTwins } from "../hub/recipe2rhino.js";
import { OP } from "../fmc/ops.js";

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

export const FMC_RHINO_DESCRIPTION =
  "Formcraft engineering hub: Rhino 8 (H1), the smooth fixed-shape parts of LOD 400 families (castors, grips, light " +
    "heads, knobs, canopies). Talks to the Formcraft bridge in the open Rhino; parts are built in the bridge's own memory, " +
    "never in the person's drawing, and files are written with openNURBS (Rhino must be licensed, or in its trial, to open). " +
    "twins: a detailed family's recipe → the smooth Fine (LOD 400) twin of each native solid, built, checked, exported, " +
    "rendered, and the recipe with import_part ops written to <staging>\\_Batch\\<family>_LOD400.json (a dry run builds and " +
    "checks in Rhino's memory and writes nothing). " +
    "status: Rhino and the bridge. new_doc / open / save: a family's part set (files only in <staging>\\_Rhino). part: " +
    "build named closed solids from the vocabulary (box_rounded, extrude, revolve, pipe, loft, torus, sphere, shell, " +
    "boolean, fillet; mm; each with subcategory, material, visibility fine|medium_fine|all), all or none. check: the rules " +
    "(closed, manifold, 1 mm edge floor, subcategory and material, the type's envelope, mesh weight). render: a shaded PNG " +
    "for the catalogue. export_parts: each part as its own .3dm (Revit reads .3dm directly) plus parts.json, after the " +
    "check passes. describe: the parts and their specs. remove: parts by name. Files: a dry run first.";

export const FMC_RHINO_SHAPE = {
  action: z.enum(["status", "describe", "new_doc", "open", "save", "part", "remove", "check", "render", "export_parts", "twins"]),
  recipe_file: z.string().optional().default("").describe("twins: the recipe, or a batch file of recipes (the family picks one)"),
  family: z.string().optional().default("").describe("The kit family name the parts belong to (FMC_<role>_…)"),
  parts: z.array(z.record(z.string(), z.any())).optional().default([]).describe("part: the parts in order, each { name, op, …values, subcategory, material, visibility }"),
  names: z.array(z.string()).optional().default([]).describe("remove: part names; render, export_parts: only these parts"),
  envelope: z.array(z.number().positive()).length(3).optional().describe("check, export_parts: the type's width, depth, height (mm); no part may be larger"),
  view: z.enum(["iso", "back_iso", "front", "side", "top"]).optional().default("iso"),
  width: z.number().int().min(64).max(4000).optional().default(1600),
  height: z.number().int().min(64).max(4000).optional().default(1200),
  replace: z.boolean().optional().default(false).describe("new_doc, open: replace parts already in the bridge for this family"),
  dry_run: z.boolean().optional().default(true).describe("save, render, export_parts: a dry run says what would be written"),
  project_folder: z.string().optional().default("").describe("export_parts: the project whose exchange keeps the rhino → revit package (default <reports>\\Exchange)"),
};

export type FmcRhinoArgs = z.infer<z.ZodObject<typeof FMC_RHINO_SHAPE>>;

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function runFmcRhino(args: FmcRhinoArgs) {
  const { config } = loadConfig();
  // owner 20 Oct: the rules come from the kit's Rhino rulebook; without it nothing passes (partProblems says why)
  const rules = loadRhinoRulebook(expandEnv(config.rulebooks_dir));
  const book = rules.book;
  const state = readRhinoState();
  const up = state !== null && processAlive(state.pid);
  if (args.action === "status") {
    if (!state) return reply({ rhino: "not found", detail: `No ${rhinoStateFile()}: Rhino isn't open, or the Formcraft bridge isn't loaded in it (fmc_apps list)` });
    if (!up) return reply({ rhino: "closed", detail: `Rhino (pid ${state.pid}) has closed` });
    try {
      return reply({ rhino: "running", port: state.port, pid: state.pid, rulebook: book ? `${rules.file} v${book.version}` : rules.problems.join("; "), ...(await rhinoCall(state.port, "rhino_status", {}, 15000)) });
    } catch (e) {
      return reply({ rhino: "running", port: state.port, pid: state.pid, bridge: e instanceof Error ? e.message : String(e) }, true);
    }
  }
  if (!up) return reply({ refused: true, reasons: ["Rhino with the Formcraft bridge isn't open (fmc_rhino status)"] }, true);
  const nameProblem = familyNameProblem(args.family);
  if (nameProblem) return reply({ refused: true, reasons: [nameProblem] }, true);

  const staging = expandEnv(config.family_staging_root);
  const where = rhinoPaths(staging, args.family, args.view);
  const call = (method: string, params: object = {}) => rhinoCall(state!.port, method, { family: args.family, ...params });
  const guard = (target: string) => checkWritePath(target, config, { checkName: false });

  try {
    switch (args.action) {
      case "twins": return reply(...(await twins(args, config, staging, where, call, book)));
      case "describe": return reply(await call("rhino_describe"));
      case "new_doc": return reply(await call("rhino_new_doc", { replace: args.replace }));
      case "remove": return reply(await call("rhino_remove", { names: args.names }));
      case "open": {
        if (!fs.existsSync(where.model)) return reply({ refused: true, reasons: [`No saved parts for ${args.family} at ${where.model}`] }, true);
        return reply(await call("rhino_open", { path: where.model, replace: args.replace }));
      }
      case "part": {
        const bad = args.parts.map((p, i) => ({ i, r: RHINO_PART.safeParse(p) })).filter((x) => !x.r.success)
          .map((x) => `part ${x.i + 1}: ${x.r.error!.issues.map((q) => `${q.path.join(".")} ${q.message}`).join("; ")}`);
        if (args.parts.length === 0) bad.push("Give the parts to build");
        if (bad.length) return reply({ refused: true, reasons: bad }, true);
        const r = await call("rhino_part", { parts: args.parts });
        const problems = partProblems((r.facts ?? []) as PartFacts[], args.envelope, book);
        return reply({ ...r, problems, next: problems.some(isError) ? "Fix the parts with errors (part again with the same name replaces one)" : "check, render, then export_parts" });
      }
      case "check": {
        const r = await call("rhino_facts");
        const problems = partProblems((r.facts ?? []) as PartFacts[], args.envelope, book);
        return reply({ family: args.family, ok: !problems.some(isError), problems, facts: r.facts });
      }
      case "save": case "render": case "export_parts": {
        const target = args.action === "save" ? where.model : args.action === "render" ? where.render : where.manifest;
        const v = guard(target);
        if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
        if (args.action === "export_parts") {
          const f = await call("rhino_facts");
          let facts = (f.facts ?? []) as PartFacts[];
          if (args.names.length) facts = facts.filter((x) => args.names.includes(x.name));
          const errors = partProblems(facts, args.envelope, book).filter(isError);
          if (errors.length) return reply({ refused: true, reasons: ["The check found errors: fix them before the parts go to Revit", ...errors] }, true);
        }
        if (args.dry_run) return reply({ dry_run: true, would_write: args.action === "export_parts" ? where.parts : target, next: "Run again with dry_run=false" });
        if (args.action === "save") {
          const r = await call("rhino_save", { path: where.model });
          log(config, "rhino_save", false, where.model, "saved", `${r.parts} parts`);
          return reply(r);
        }
        if (args.action === "render") {
          const r = await call("rhino_render", { path: where.render, view: args.view, width: args.width, height: args.height, ...(args.names.length ? { parts: args.names } : {}) });
          log(config, "rhino_render", false, where.render, "rendered", `${r.parts} parts`);
          return reply(r);
        }
        const r = await call("rhino_export_parts", { folder: where.parts, ...(args.names.length ? { parts: args.names } : {}) });
        const parts = ((r.parts ?? []) as PartFacts[]).map((p) => ({ ...p, sha256: p.file && fs.existsSync(p.file) ? sha256(p.file) : "" }));
        // RHN-010: the proof Revit asks for: these files passed the check under this rulebook (fmc_recipe checks the SHA-256)
        const manifest = { family: args.family, exported: new Date().toISOString(), from: "rhino", to: "revit", units: "mm",
          check: { ok: true, rulebook: RHINO_RULEBOOK_FILE, rulebook_version: book!.version },
          note: "Each part is a closed solid in its own .3dm, its origin the point Revit places it at (fmc_doc import_part)", parts };
        // a family exported for the first time has no parts folder yet
        fs.mkdirSync(win.dirname(where.manifest), { recursive: true });
        fs.writeFileSync(where.manifest, JSON.stringify(manifest, null, 2));
        log(config, "rhino_export_parts", false, where.parts, "exported", `${parts.length} parts`);
        // the hub (X0): the hand-over is kept as an exchange package; a hub problem never stops the export
        let hub: object;
        try {
          const root = exchangeRoot(args.project_folder ? expandEnv(args.project_folder) : undefined, expandEnv(config.reports_dir));
          const pkg = writePackage(root, { from: "rhino", to: "revit", what: `parts ${args.family}`, files: [{ name: "parts.json", text: JSON.stringify(manifest, null, 2) }],
            source: { family: args.family, folder: where.parts } });
          hub = { exchange: root, package: pkg.manifest.id };
        } catch (e) {
          hub = { error: `the hub couldn't record this export: ${e instanceof Error ? e.message : String(e)}` };
        }
        return reply({ family: args.family, folder: where.parts, manifest: where.manifest, parts: parts.map((p) => ({ name: p.name, file: p.file, bytes: p.bytes })),
          problems: partProblems(parts, args.envelope, book), hub });
      }
    }
    return reply({ error: `Unknown action ${args.action}` }, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(config, "rhino_" + args.action, args.dry_run, args.family, "error", msg);
    return reply({ error: msg }, true);
  }
}

/**
 * twins: a detailed family's Fine level (LOD 400) from its own recipe (hub/recipe2rhino.ts). Each native solid's smooth
 * twin is built in Rhino one at a time (a twin that fails is reported and its native solid stays on Fine), checked,
 * and, in a real run, exported, rendered and saved; the recipe with the import_part ops goes to
 * <staging>\_Batch\<family>_LOD400.json for fmc_recipe batch (a dry run first, as always).
 */
async function twins(args: FmcRhinoArgs, config: GuardConfig, staging: string, where: ReturnType<typeof rhinoPaths>,
  call: (method: string, params?: object) => Promise<Record<string, any>>, book: RhinoRulebook | null): Promise<[object, boolean]> {
  if (!book) return [{ refused: true, reasons: [partProblems([], undefined, null)[0]] }, true];
  if (!args.recipe_file) return [{ refused: true, reasons: ["Name the recipe_file (a recipe, or a batch file of recipes)"] }, true];
  const file = expandEnv(args.recipe_file);
  if (!fs.existsSync(file)) return [{ refused: true, reasons: [`No recipe at ${file}`] }, true];
  const read = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const recipe = (Array.isArray(read) ? read : [read]).find((r: any) => r?.family === args.family);
  if (!recipe || !Array.isArray(recipe.ops)) return [{ refused: true, reasons: [`${file} has no recipe for ${args.family}`] }, true];

  const t = recipeTwins(recipe.ops);
  await call("rhino_new_doc", { replace: true });
  const failed: Array<{ part: string; solid: string; reason: string }> = [];
  for (const p of t.parts) {
    try { await call("rhino_part", { parts: [p] }); }
    catch (e) { failed.push({ part: p.name, solid: t.map.find((m) => m.part === p.name)!.solid, reason: e instanceof Error ? e.message : String(e) }); }
  }
  const facts = (((await call("rhino_facts")).facts ?? []) as PartFacts[]);
  // F-067: every twin's real box against the family's Coarse envelope, so a body drawn off its envelope can't pass
  // a part shown only when the family is Open (an open door or hatch) reaches past the closed envelope by design
  const openOnly = openOnlySolids(recipe.ops);
  const openParts = new Set(t.map.filter((m) => openOnly.has(m.solid)).map((m) => m.part));
  const env = envelopeVerdict(recipe.ops, facts.filter((f) => !openParts.has(f.name)), book.limits.envelope_error_mm);
  const offEnvelope = new Map(env.errors.map((e) => [e.part, e.by]));
  const good: PartFacts[] = [];
  for (const f of facts) {
    const errors = partProblems([f], undefined, book).filter(isError);
    if (offEnvelope.has(f.name)) errors.push(`${offEnvelope.get(f.name)} mm outside the Coarse envelope (more than ${book.limits.envelope_error_mm} mm)`);
    if (errors.length) failed.push({ part: f.name, solid: t.map.find((m) => m.part === f.name)?.solid ?? f.name, reason: errors.join("; ") });
    else good.push(f);
  }
  const mesh = good.reduce((n, f) => n + (f.mesh_faces || 0), 0);
  const out = win.join(staging, "_Batch", `${args.family}_LOD400.json`);
  const summary = {
    family: args.family, recipe: file, twins: t.parts.length, built_and_checked: good.length, failed, stays_native: t.kept.length,
    kept: t.kept.slice(0, 40), mesh_faces: mesh, materials: materialCheck(recipe.ops, t.map),
    envelope: env.box ? { box: env.box, outside_errors: env.errors.length, outside_warnings: env.warnings, family_off: env.family_off } : "no Coarse envelope in the recipe: not checked",
  };
  if (env.family_off)
    return [{ refused: true, ...summary, reasons: [`${env.errors.length} of ${facts.length} twins sit more than ${book.limits.envelope_error_mm} mm outside the Coarse envelope: the recipe's body is off its envelope (F-067). Fix the recipe; nothing was written`] }, true];
  if (args.dry_run) return [{ dry_run: true, ...summary, would_write: [where.parts, where.model, where.render, out], next: "Run again with dry_run=false" }, false];

  for (const target of [where.manifest, where.model, where.render, out]) {
    const v = checkWritePath(target, config, { checkName: false });
    if (!v.ok) return [{ refused: true, reasons: v.reasons }, true];
  }
  const names = good.map((f) => f.name);
  const ex = await call("rhino_export_parts", { folder: where.parts, parts: names });
  const parts = ((ex.parts ?? []) as PartFacts[]).map((p) => ({ ...p, sha256: p.file && fs.existsSync(p.file) ? sha256(p.file) : "" }));
  const manifest = { family: args.family, exported: new Date().toISOString(), from: "rhino", to: "revit", units: "mm", level: "Fine (LOD 400)",
    check: { ok: true, rulebook: RHINO_RULEBOOK_FILE, rulebook_version: book.version },
    note: "Smooth twins of the recipe's native solids, at the recipe's own coordinates (fmc_rhino twins)", parts };
  // a family twinned for the first time has no parts folder yet
  fs.mkdirSync(win.dirname(where.manifest), { recursive: true });
  fs.writeFileSync(where.manifest, JSON.stringify(manifest, null, 2));
  await call("rhino_save", { path: where.model });
  const renders: string[] = [];
  for (const view of ["iso", "front", "back_iso"]) {
    const png = rhinoPaths(staging, args.family, view).render;
    await call("rhino_render", { path: png, view, width: 1600, height: 1200 });
    renders.push(png);
  }
  const exported = new Map(parts.map((p) => [p.name, { file: p.file!, size_mm: partSize(p) }]));
  const lod = withTwins(recipe.ops, t.map, exported);
  const bad = lod.ops.filter((o) => o.op === "import_part").map((o) => OP.safeParse(o)).filter((r) => !r.success);
  if (bad.length) return [{ error: "the import_part ops don't match the op schema", detail: bad.map((b) => b.error!.message).slice(0, 3) }, true];
  const stamp = new Date().toISOString().slice(0, 10);
  const next = { ...recipe, about: `${recipe.about ?? ""} · Fine (LOD 400): ${lod.twins} smooth Rhino twins of the native solids (fmc_rhino twins, ${stamp}); Medium keeps the native body`, ops: lod.ops };
  fs.mkdirSync(win.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify([next], null, 2));
  log(config, "rhino_twins", false, out, "written", `${lod.twins} twins, ${failed.length} stay native`);
  let hub: object;
  try {
    const root = exchangeRoot(args.project_folder ? expandEnv(args.project_folder) : undefined, expandEnv(config.reports_dir));
    const pkg = writePackage(root, { from: "rhino", to: "revit", what: `Fine twins ${args.family}`, files: [{ name: "parts.json", text: JSON.stringify(manifest, null, 2) }],
      source: { family: args.family, recipe: file, batch: out } });
    hub = { exchange: root, package: pkg.manifest.id };
  } catch (e) { hub = { error: e instanceof Error ? e.message : String(e) }; }
  return [{ ...summary, twins_in_recipe: lod.twins, parts_folder: where.parts, renders, batch_file: out, hub,
    next: `fmc_recipe batch recipe_files=["${out}"] (a dry run first), then batch_gate` }, false];
}

export function registerFmcRhinoTool(server: McpServer) {
  server.tool("fmc_rhino", FMC_RHINO_DESCRIPTION, FMC_RHINO_SHAPE, (args) => runFmcRhino(args));
}
