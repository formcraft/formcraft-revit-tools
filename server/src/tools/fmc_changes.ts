import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import { Recipe, parseRecipe } from "../fmc/recipes.js";
import { recipeRevision } from "../fmc/recipebatch.js";
import { exchangeRoot, listPackages } from "../hub/exchange.js";
import { Change, FamilyFact, TreeFact, familyChanges, flowChanges, treeChanges } from "../hub/changes.js";
import { TREE, planTree } from "../tree/tree.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { writeReport } from "../fmc/localreport.js";
import {
  SEVERITIES, atLeast, changeSeverity, countBySeverity, modelChanges, pickBaseline, readVersions, recordVersion,
  type ModelRow, type Severity,
} from "../hub/modelchanges.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_CHANGES_DESCRIPTION =
  "Formcraft changes flow (docs/PLAN_ENGINEERING_HUB.md, X2), read-only: what changed in one app and what it affects in " +
    "the others. Rhino part files changed after the families that import them were built; recipes changed after their " +
    "family was staged (recipe_files: the batch or recipe files to compare with); the recipe tree changed since its last " +
    "build or since its Power BI data and Navisworks sets were sent; an app's results older than the last model sent to it " +
    "(from the project's exchange packages). Each flag names the dry run that would update the other side; it never runs " +
    "an update itself. Every flag has a severity (high, medium, low). " +
    "model true also reads the open Revit model, read-only: the elements created, modified or deleted since a time (since, ISO) " +
    "or a document version (base_version). Revit keeps no time per element, so each model read records the document version " +
    "with the time, and since picks the newest version recorded at or before it (blank since: the last model read). " +
    "Deleted ids are tracked by Revit only in workshared models. Each element has a severity: deletions and levels, grids, " +
    "structure, walls, floors, roofs, stairs, links and equipment are high; other model elements medium; annotation, views " +
    "and types low. min_severity filters the list and the reply counts what it left out; the full list is a local report.";

export const FMC_CHANGES_SHAPE = {
  project_folder: z.string().optional().default("").describe("The project (its recipe tree and exchange packages); empty: families only"),
  recipe_files: z.array(z.string()).optional().default([]).describe("Recipe or batch files the staged families should match"),
  families: z.boolean().optional().default(true).describe("Check the staged families' parts and recipes"),
  model: z.boolean().optional().default(false).describe("Also read the open Revit model (read-only): elements changed since `since`"),
  document: z.string().optional().default("").describe("model: exact title or full path when more than one document is open"),
  since: z.string().optional().default("").describe("model: ISO time, e.g. 2026-11-28T09:00:00+03:00. Blank: since the last model read"),
  base_version: z.string().optional().default("").describe("model: a document version GUID from an earlier reply, instead of since"),
  min_severity: z.enum(["high", "medium", "low"]).optional().default("low").describe("Only list flags and elements at or above this severity"),
  limit: z.number().int().min(1).max(500).optional().default(100).describe("model: most elements listed (the counts and the report have all)"),
};
export type FmcChangesArgs = z.infer<z.ZodObject<typeof FMC_CHANGES_SHAPE>>;

const mtime = (f: string): number | undefined => { try { return fs.statSync(f).mtimeMs; } catch { return undefined; } };

/** Every staged family with a recipe beside it (the archive, batch and Rhino folders left out). */
function stagedRecipes(root: string): Array<{ rfa: string; recipe: Recipe }> {
  const out: Array<{ rfa: string; recipe: Recipe }> = [];
  const walk = (dir: string) => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = win.join(dir, d.name);
      if (d.isDirectory()) { if (!/^_(Archive|Batch|Rhino|Images|ChainTests)$/i.test(d.name)) walk(p); continue; }
      if (!/\.recipe\.json$/i.test(d.name)) continue;
      try { const r = parseRecipe(fs.readFileSync(p, "utf8")).recipe; if (r) out.push({ rfa: p.replace(/\.recipe\.json$/i, ".rfa"), recipe: r }); } catch { /* unreadable: skipped */ }
    }
  };
  walk(root);
  return out;
}

const partsOf = (r: Recipe): string[] => ((r.ops ?? []) as Array<{ op?: string; file?: string }>).filter((o) => o.op === "import_part" && o.file).map((o) => o.file!);

export interface ChangesIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface ModelReply {
  model?: string; resolved_document?: { title?: string; path?: string }; is_workshared?: boolean;
  version?: { guid?: string; saves?: number }; compared?: boolean; base_error?: string; deleted_available?: boolean;
  created?: ModelRow[]; modified?: ModelRow[]; deleted?: ModelRow[];
}

/** The model part of fmc_changes: one read-only Revit call, the version recorded, the changes with severities. */
export async function modelSection(args: FmcChangesArgs, io: ChangesIo = {}): Promise<Record<string, unknown>> {
  const env = io.env ?? process.env;
  const now = io.now ? io.now() : Date.now();
  const notes: string[] = [];
  let base = args.base_version.trim();
  let baseline: { at: string; guid: string } | null = null;
  let sinceMs: number | null = null;
  if (!base) {
    if (args.since.trim()) {
      sinceMs = Date.parse(args.since.trim());
      if (!Number.isFinite(sinceMs)) return { ok: false, code: "FMC-CHANGES-SINCE", message: `since is not a time: ${args.since}. Use ISO, e.g. 2026-11-28T09:00:00+03:00.` };
    }
  }
  const read = (body: Record<string, unknown>) => (io.read ? io.read(body) : withRevitConnection((c) => c.sendRaw("fmc_model_changes", body, 120000)));
  // First the current document and version (no compare), so the baseline is looked up for the document Revit resolves.
  const first = (await read({ document: args.document })) as ModelReply;
  const title = first.resolved_document?.title || first.model || args.document;
  const names = [title, first.resolved_document?.path ?? "", args.document].filter(Boolean);
  if (!base) {
    const rows = readVersions(env);
    const pick = pickBaseline(rows, names, sinceMs ?? now);
    if (pick.row) { base = pick.row.guid; baseline = { at: pick.row.at, guid: pick.row.guid }; }
    else notes.push(pick.earliest
      ? `No model version of ${title} was recorded at or before ${new Date(sinceMs ?? now).toISOString()}; the earliest recorded is ${pick.earliest}. Ask with a later since.`
      : `No model version of ${title} was recorded before. This read recorded the current one; ask again later for what changed since now.`);
  }
  const current = first.version?.guid ?? "";
  let second: ModelReply = first;
  const unchanged = !!base && base === current;
  if (unchanged) notes.push("The document version has not changed since the baseline. Revit moves the version when elements are created; an edit alone may not move it until the next save.");
  else if (base) second = (await read({ document: args.document, base_version: base })) as ModelReply;
  if (current) recordVersion({ at: new Date(now).toISOString(), document: title, guid: current, saves: Number(first.version?.saves ?? 0) }, env);
  if (second.base_error) notes.push(second.base_error);
  if (second.compared && second.deleted_available === false) notes.push("Revit tracks deleted ids only in workshared models: deletions are not listed for this document.");
  const all = second.compared ? modelChanges(second) : [];
  const listed = all.filter((row) => atLeast(row.severity, args.min_severity as Severity));
  const report = all.length ? writeReport("changes", "model", { document: title, baseline, base_version: base, changes: all }, env) : undefined;
  return {
    ok: second.compared === true || unchanged || (!base && !second.base_error),
    unchanged: unchanged || undefined,
    document: first.resolved_document ?? { title, path: "" },
    version: first.version ?? null,
    is_workshared: first.is_workshared ?? null,
    compared: second.compared === true,
    since: sinceMs !== null ? new Date(sinceMs).toISOString() : undefined,
    baseline: baseline ?? (base ? { guid: base } : null),
    counts: {
      created: second.created?.length ?? 0, modified: second.modified?.length ?? 0, deleted: second.deleted?.length ?? 0,
      listed: Math.min(listed.length, args.limit), below_min_severity: all.length - listed.length, over_limit: Math.max(0, listed.length - args.limit),
    },
    by_severity: countBySeverity(all),
    changes: listed.slice(0, args.limit),
    report, notes,
  };
}

export async function runFmcChanges(args: FmcChangesArgs, io: ChangesIo = {}) {
  const { config } = loadConfig();
  try {
    const changes: Change[] = [];
    const notes: string[] = [];
    if (args.families) {
      const sources = new Map<string, string>();
      for (const f of args.recipe_files) {
        try {
          const raw = JSON.parse(fs.readFileSync(expandEnv(f), "utf8").replace(/^﻿/, ""));
          for (const one of Array.isArray(raw) ? raw : [raw]) { const r = parseRecipe(JSON.stringify(one)).recipe; if (r) sources.set(r.family, recipeRevision(r)); }
        } catch { notes.push(`${win.basename(f)}: not readable`); }
      }
      const staged = stagedRecipes(expandEnv(config.family_staging_root));
      const facts: FamilyFact[] = staged.map((s) => ({ family: s.recipe.family, built: mtime(s.rfa), staged_revision: recipeRevision(s.recipe),
        source_revision: sources.get(s.recipe.family) ?? null, parts: partsOf(s.recipe).map((file) => ({ file, modified: mtime(file) })) }));
      // a recipe given and never staged
      for (const [family, rev] of sources) if (!facts.some((f) => f.family === family)) facts.push({ family, source_revision: rev, staged_revision: null, parts: [] });
      changes.push(...familyChanges(facts));
      notes.push(`${staged.length} staged families checked`);
    }
    const project = expandEnv(args.project_folder.trim());
    if (project) {
      const root = exchangeRoot(project, expandEnv(config.reports_dir));
      const pkgs = listPackages(root);
      const treeFile = win.join(project, "01_WIP", "_Tree", "FMC_Recipe_Tree.json");
      let tf: TreeFact | null = null;
      if (fs.existsSync(treeFile)) {
        const tree = TREE.parse(JSON.parse(fs.readFileSync(treeFile, "utf8").replace(/^﻿/, "")));
        const stateFile = win.join(project, "01_WIP", "_Tree", "FMC_Recipe_Tree.state.json");
        const last = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
        const sent = (to: string, what: string) => pkgs.filter((p) => p.to === to && p.what === what).map((p) => Date.parse(p.created)).sort((a, b) => b - a)[0];
        tf = { file: treeFile, modified: mtime(treeFile)!, last_build: last?.built_at ? Date.parse(last.built_at) : undefined,
          changed_nodes: planTree(tree, last).filter((l) => l.state !== "unchanged" && l.tool).map((l) => l.id),
          exports: { ...(sent("powerbi", "Recipe tree quantities") ? { powerbi: sent("powerbi", "Recipe tree quantities") } : {}),
            ...(sent("navisworks", "Recipe tree search sets") ? { navisworks: sent("navisworks", "Recipe tree search sets") } : {}) } };
        for (const c of treeChanges(tf)) { if (c.update) c.update.args.project_folder = project; changes.push(c); }
      } else notes.push("No recipe tree in this project");
      changes.push(...flowChanges(pkgs.map((p) => ({ from: p.from, to: p.to, created: p.created, what: p.what }))));
      notes.push(`${pkgs.length} exchange packages read`);
    }
    const rated = changes.map((c) => ({ ...c, severity: changeSeverity(c) }));
    const flags = rated.filter((c) => atLeast(c.severity, args.min_severity as Severity));
    let model: Record<string, unknown> | undefined;
    if (args.model) {
      try { model = await modelSection(args, io); }
      catch (e) { model = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    return reply({ changes: changes.length, by_severity: countBySeverity(rated), min_severity: args.min_severity,
      below_min_severity: rated.length - flags.length, severities: SEVERITIES, flags, notes, model,
      next: changes.length ? "Each flag's update is a dry run: run it, show the result, then run it for real after a yes" : "Nothing is out of date" },
      model ? model.ok === false && "error" in model : false);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerFmcChangesTool(server: McpServer) {
  server.tool("fmc_changes", FMC_CHANGES_DESCRIPTION, FMC_CHANGES_SHAPE, (args) => runFmcChanges(args));
}
