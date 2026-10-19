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
    "an update itself.";

export const FMC_CHANGES_SHAPE = {
  project_folder: z.string().optional().default("").describe("The project (its recipe tree and exchange packages); empty: families only"),
  recipe_files: z.array(z.string()).optional().default([]).describe("Recipe or batch files the staged families should match"),
  families: z.boolean().optional().default(true).describe("Check the staged families' parts and recipes"),
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

export async function runFmcChanges(args: FmcChangesArgs) {
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
    return reply({ changes: changes.length, flags: changes, notes,
      next: changes.length ? "Each flag's update is a dry run: run it, show the result, then run it for real after a yes" : "Nothing is out of date" });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerFmcChangesTool(server: McpServer) {
  server.tool("fmc_changes", FMC_CHANGES_DESCRIPTION, FMC_CHANGES_SHAPE, (args) => runFmcChanges(args));
}
