import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { MaterialDb, ModelMaterial, auditMaterials, parseMaterialDb, resolveMaterial, searchMaterials } from "../fmc/materials.js";

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

/** The kit's material library (materials_file in fmc_guard.json), or null when it isn't readable. fmc_doc uses it too. */
export function readDb(cfg: GuardConfig): MaterialDb | null {
  try { return parseMaterialDb(JSON.parse(fs.readFileSync(expandEnv(cfg.materials_file), "utf8").replace(/^﻿/, ""))); }
  catch { return null; }
}

export const FMC_MATERIAL_DESCRIPTION =
  "Formcraft materials from the kit's database (FMC_Materials.json). database lists materials (class, search) with " +
    "keynote, cost code, supplier, texture maps and graphics. audit (read-only) checks the active model: materials not in " +
    "the database, duplicates, broken texture paths, unused, names not FMC_ standard. assign gives types a database " +
    "material (selected elements' types, every type in a category, or type name contains …) on a finish layer, the type " +
    "material or a family Finish parameter; purge removes unused materials. assign and purge are dry runs unless " +
    "dry_run is false, change no geometry, and are refused on live projects. request records a new material for the BIM Manager.";

export const FMC_MATERIAL_SHAPE = {
  action: z.enum(["database", "audit", "assign", "purge", "request", "updates"]),
  class: z.string().optional(),
  query: z.string().optional(),
  material: z.string().optional().describe("assign: database material name"),
  target: z.enum(["selection", "category", "rule"]).optional().default("category"),
  category: z.enum(["Floors", "Walls", "Ceilings", "Roofs", "Doors"]).optional(),
  contains: z.string().optional().describe("assign target rule: type name contains"),
  parameter: z.enum(["finish_layer", "type_material", "family_finish"]).optional().default("finish_layer"),
  name: z.string().optional().describe("request: proposed material name"),
  text: z.string().optional().describe("request: class, supplier and why"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcMaterialArgs = z.infer<z.ZodObject<typeof FMC_MATERIAL_SHAPE>>;

export async function runFmcMaterial(args: FmcMaterialArgs) {
  const { config, problem } = loadConfig();
  const db = readDb(config);
  const dry = args.dry_run !== false;
  try {
    switch (args.action) {
      case "database":
        if (!db) return reply({ refused: true, reasons: [`Material database not readable at ${config.materials_file} (materials_file in fmc_guard.json)`] }, true);
        return reply({ file: config.materials_file, version: db.version, count: db.materials.length, classes: db.classes,
          materials: searchMaterials(db, args.class ?? "All", args.query ?? "").map(({ description, ...m }) => m), problems: db.problems });

      case "updates": {
        if (!db) return reply({ refused: true, reasons: [`Material database not readable at ${config.materials_file}`] }, true);
        const seenFile = win.join(expandEnv(config.reports_dir), "FMC_Materials_seen.json");
        let seen = "";
        try { seen = JSON.parse(fs.readFileSync(seenFile, "utf8")).version ?? ""; } catch { seen = ""; }
        fs.mkdirSync(win.dirname(seenFile), { recursive: true });
        fs.writeFileSync(seenFile, JSON.stringify({ version: db.version, at: new Date().toISOString() }));
        return reply({ version: db.version, previous: seen, changed: seen !== "" && seen !== db.version });
      }

      case "request": {
        if (!(args.name ?? "").trim()) return reply({ refused: true, reasons: ["request needs the material's name"] }, true);
        const file = win.join(expandEnv(config.reports_dir), "FMC_Material_Requests.csv");
        fs.mkdirSync(win.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "name", "detail", "status"]));
        fs.appendFileSync(file, csvLine([new Date().toISOString(), args.name!.trim(), args.text ?? "", "requested"]));
        log(config, "material_request", false, file, "done", args.name!);
        return reply({ requested: args.name, file, next: "The BIM Manager adds it to the database with its textures" });
      }

      case "audit": {
        const facts = await withRevitConnection((c) => c.sendRaw("fmc_material_facts", {}, 300000));
        const checks = auditMaterials((facts?.materials ?? []) as ModelMaterial[], db, (p) => fs.existsSync(p));
        log(config, "material_audit", false, facts?.model ?? "", "done", checks.map((c) => `${c.check}: ${c.found}`).join(" | "));
        return reply({ model: facts?.model, checks, database_problem: db ? undefined : `Material database not readable at ${config.materials_file}` });
      }

      case "assign": {
        const reasons: string[] = [];
        const m = db?.materials.find((x) => x.name === args.material);
        if (!db) reasons.push(`Material database not readable at ${config.materials_file}`);
        else if (!m) reasons.push(`${args.material ?? "(none)"} isn't in the material database`);
        if (args.target !== "selection" && !args.category) reasons.push("Pick the category");
        if (args.target === "rule" && !(args.contains ?? "").trim()) reasons.push("Say what the type name contains");
        if (reasons.length) return reply({ refused: true, reasons }, true);
        // A material the model doesn't have yet is made from the database, textures included (absolute paths on this PC).
        const resolved = resolveMaterial(m!, expandEnv(config.materials_file), (p) => fs.existsSync(p));
        const params = { material: { ...m, ...resolved.material }, target: args.target, category: args.category, contains: args.contains ?? "", parameter: args.parameter, dry_run: dry };
        // The plan only reads; the real run is model-changing and goes through the live-model lock.
        const r = await withRevitConnection((c) => dry ? c.sendRaw("fmc_material_assign", params, 300000) : c.sendCommand("fmc_material_assign", params, 300000));
        if (!dry) log(config, "material_assign", false, args.material!, "done", `${(r?.types ?? []).length} types`);
        const textureWarnings = [...resolved.warnings, ...((r?.warnings ?? []) as string[])];
        return reply(dry ? { dry_run: true, would_change: r?.types ?? [], creates_material: r?.creates ?? false,
                             ...(r?.creates && textureWarnings.length ? { texture_warnings: textureWarnings } : {}), next: "Run again with dry_run=false" }
                         : { done: true, changed: r?.types ?? [], created: r?.creates ?? false, ...(textureWarnings.length && r?.creates ? { texture_warnings: textureWarnings } : {}) });
      }

      case "purge": {
        const r = await withRevitConnection((c) => dry ? c.sendRaw("fmc_material_purge", { dry_run: true }, 300000) : c.sendCommand("fmc_material_purge", { dry_run: false }, 300000));
        if (!dry) log(config, "material_purge", false, "", "done", `${(r?.materials ?? []).length} purged`);
        return reply(dry ? { dry_run: true, would_purge: r?.materials ?? [] } : { done: true, purged: r?.materials ?? [] });
      }
    }
    return reply({ refused: true, reasons: ["Unknown action"] }, true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "material_" + args.action, dry, args.material ?? "", "error", msg);
    return reply({ error: msg, config_problem: problem }, true);
  }
}

export function registerFmcMaterialTool(server: McpServer) {
  server.tool("fmc_material", FMC_MATERIAL_DESCRIPTION, FMC_MATERIAL_SHAPE, (args) => runFmcMaterial(args));
}
