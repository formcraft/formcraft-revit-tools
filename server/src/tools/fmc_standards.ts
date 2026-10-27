import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { kitPaths, recipeIndex } from "../fmc/context.js";
import { formcraftDir } from "../fmc/aiuse_io.js";
import { SourcesFile, StandardsFile, findRecipes, lookup, relatedStandards, resolve, sourcesView, suggestRecipe } from "../fmc/standards.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_STANDARDS_DESCRIPTION =
  "Formcraft building standards (owner 26 Oct): the values to design with when no recipe or brief says otherwise, and " +
  "the recipe to use. action get {topic? (e.g. stairs, doors.internal, ceiling, parapet), use? (residential, office, " +
  "retail, education, healthcare, industrial)}: the values, in mm unless the unit says, each with its source (project " +
  "or kit) and status (approved, proposed: a proposed kit value is typical practice, not yet signed off; say so when " +
  "you use it). The project's 01_WIP\\FMC_Project_Standards.json overrides the kit. action recipe {words (e.g. sliding " +
  "door, louvred gable vent), discipline? (A, E, FP, I, M, P)}: the kit recipes that fit, best first; when none fits, " +
  "the recipe name and folder to write and the standards to build it from, and the request is logged for the BIM " +
  "Manager. action set {key, value, note?}: a project value (written to the project's 01_WIP). action sources {topic? (a " +
  "source id, title words or a key)}: the codes the values come from (revision, file fingerprint, what was read) and the " +
  "gaps still open (figures, tables, lost digits, things to confirm, parts not read): fill them as you go. Always check here " +
  "before inventing a size, height or type.";

export function registerFmcStandardsTool(server: McpServer) {
  server.tool(
    "fmc_standards",
    FMC_STANDARDS_DESCRIPTION,
    {
      action: z.enum(["get", "recipe", "set", "sources"]).optional().default("get"),
      topic: z.string().optional(),
      use: z.string().optional(),
      words: z.string().optional(),
      discipline: z.string().optional(),
      key: z.string().optional(),
      value: z.any().optional(),
      note: z.string().optional(),
      project_folder: z.string().optional().describe("The project folder (the one holding 01_WIP); default the open model's project"),
    },
    async (args) => {
      try {
        const { config } = loadConfig();
        const k = kitPaths(config);
        const kitFile = win.join(win.dirname(k.recipesDir), "FMC_Standards_Building.json");
        const kit = readJson<StandardsFile>(kitFile);
        const project = projectFolder(args.project_folder);
        const projFile = project ? win.join(project, "01_WIP", "FMC_Project_Standards.json") : "";
        const proj = projFile ? readJson<Record<string, unknown>>(projFile) : null;
        const all = resolve(kit, proj, args.use);
        const where = { kit: kit ? kitFile : `missing: ${kitFile}`, project: projFile || "no project folder found" };

        if (args.action === "sources") {
          const regFile = win.join(win.dirname(kitFile), "FMC_Standards_Sources.json");
          const reg = readJson<SourcesFile>(regFile);
          if (!reg) return reply({ error: `No sources register at ${regFile}` }, true);
          return reply({ ...sourcesView(reg, args.topic), file: regFile,
            next: "Fill a gap from the printed code (or a better copy), then the BIM Manager updates the value and marks the gap filled in the register" });
        }

        if (args.action === "set") {
          if (!projFile) return reply({ error: "No project folder: give project_folder (the folder holding 01_WIP)" }, true);
          if (!args.key || args.value === undefined) return reply({ error: "set needs key and value" }, true);
          const next = { ...(proj ?? {}), [args.key]: { value: args.value, ...(args.note ? { note: args.note } : {}), status: "project" } };
          fs.mkdirSync(win.dirname(projFile), { recursive: true });
          fs.writeFileSync(projFile, JSON.stringify(next, null, 2));
          return reply({ set: args.key, value: args.value, file: projFile });
        }

        if (args.action === "recipe") {
          const words = String(args.words ?? args.topic ?? "");
          if (!words.trim()) return reply({ error: "recipe needs words, e.g. sliding door" }, true);
          const found = findRecipes(recipeIndex(k), words);
          const related = relatedStandards(all, words);
          if (found.length && found[0].score >= 0.5) return reply({ found, standards: related, where });
          const s = suggestRecipe(words, args.discipline ?? "A");
          const request = { at: new Date().toISOString(), words, suggested: s.name, folder: s.folder, project };
          try { fs.mkdirSync(formcraftDir(), { recursive: true }); fs.appendFileSync(win.join(formcraftDir(), "recipe_requests.jsonl"), JSON.stringify(request) + "\n"); } catch { /* still answers */ }
          return reply({
            found: [], near: found, missing: true,
            write: { name: s.name + ".recipe.json", folder: win.join(win.dirname(k.recipesDir), s.folder), tool: "fmc_recipe check, then build" },
            standards: related,
            next: "No kit recipe fits. Build it from these standards now (new_family and modify_model's family ops, or a recipe with fmc_recipe), and say it was made without a kit recipe. The request is logged for the BIM Manager.",
            where,
          });
        }

        const values = lookup(all, args.topic);
        return reply({ use: args.use ?? null, count: values.length, values, where,
          ...(values.some((v) => v.status === "proposed") ? { note: "proposed values are typical practice, not yet approved by the BIM Manager: tell the person when a design depends on one" } : {}) });
      } catch (e) {
        return reply({ error: e instanceof Error ? e.message : String(e) }, true);
      }
    }
  );
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T; } catch { return null; }
}

/** The given folder, else the folder holding 01_WIP above the last model the plugin saw open. */
function projectFolder(given?: string): string {
  if (given) return given;
  const last = readJson<{ active?: { path?: string } }>(win.join(formcraftDir(), "last_document.json"));
  const p = last?.active?.path ?? "";
  const i = p.toLowerCase().indexOf("\\01_wip\\");
  return i > 0 ? p.slice(0, i) : "";
}
