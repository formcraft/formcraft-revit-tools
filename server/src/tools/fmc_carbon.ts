import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { configPath, expandEnv, loadConfig } from "../fmc/policy.js";
import { errorCode, gapReply } from "../fmc/gapcommon.js";
import { CARBON_OWNER_NOTE, computeCarbon, factorsPathFor, kitDensities, loadFactors, type CarbonRead, type LoadedFactors } from "../fmc/carbon.js";

export const FMC_CARBON_DESCRIPTION =
  "GAP-24. Read-only embodied carbon by material and by assembly (category and type) for Revit 2025, from material volumes in the model " +
  "and the kit's carbon factors (07_Materials/FMC_CarbonFactors.json beside FMC_Materials.json, or the file given as factors). " +
  "No factor is built in: a material without a sourced factor is listed as unfactored, and with no factor file the status is NO_FACTORS and totals are null. " +
  "A per-kg factor uses the factor's density or the kit material's physical.density_kg_m3. Status COMPLETE needs an approved file and approved factors for every material. " +
  "Nothing in the model changes. Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER.";

export const FMC_CARBON_SHAPE = {
  document: z.string().optional().default(""),
  factors: z.string().optional().default("").describe("A factor JSON path. Empty uses FMC_CarbonFactors.json beside the kit materials file."),
  categories: z.array(z.string()).optional().default([]).describe("Revit category names to include. Empty uses the default building categories."),
  max_elements: z.number().int().min(1).max(500000).optional().default(100000),
};

export type FmcCarbonArgs = z.infer<z.ZodObject<typeof FMC_CARBON_SHAPE>>;

export interface CarbonIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  materialsFile?: string;
  factors?: LoadedFactors;
  materialsJson?: unknown;
}

export async function runFmcCarbon(args: FmcCarbonArgs, io: CarbonIo = {}) {
  const stamp = { tool: "fmc_carbon", read_only: true, saved: false, synced: false };
  try {
    if (!args.document.trim()) return gapReply({ ...stamp, refused: true, code: "FMC-DOC-REQUIRED", message: "fmc_carbon needs document, a title or a full path. The active document is not a guess." }, true);
    let materialsFile = io.materialsFile ?? "";
    if (io.materialsFile == null) { try { materialsFile = expandEnv(loadConfig(configPath(process.env)).config.materials_file ?? ""); } catch { materialsFile = ""; } }
    const factorPath = factorsPathFor(materialsFile, args.factors);
    const loaded = io.factors ?? loadFactors(factorPath);
    let materialsJson = io.materialsJson;
    if (materialsJson == null && materialsFile) { try { materialsJson = JSON.parse(fs.readFileSync(materialsFile, "utf8")); } catch { materialsJson = null; } }
    const body = { document: args.document.trim(), categories: args.categories, max_elements: args.max_elements };
    const raw = io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_carbon", body, 600000));
    const read = (raw && typeof raw === "object" ? raw : {}) as CarbonRead;
    const result = computeCarbon({ ...read, materials: read.materials ?? [], assemblies: read.assemblies ?? [] }, loaded, kitDensities(materialsJson));
    const version = Number.parseInt(String(read.revit_version ?? ""), 10);
    const notes: string[] = [];
    if (result.status === "NO_FACTORS") notes.push(CARBON_OWNER_NOTE);
    if (Number.isFinite(version) && version >= 2027) notes.push("Revit 2027 has EmbodiedCarbonAsset on materials. This tool still uses the kit factors so results match across versions.");
    if (Number.isFinite(version) && version < 2025) notes.push(`Built and checked for Revit 2025; this is ${version}.`);
    if (read.capped) notes.push(`Stopped at max_elements (${args.max_elements}); totals are partial.`);
    notes.push("Volumes are Revit material volumes (GetMaterialVolume). Rebar, MEP and elements with no material volume are not counted.");
    return gapReply({
      ...stamp, document: read.title ?? args.document, revit_version: read.revit_version ?? "",
      factors: { path: loaded.path, found: loaded.found, status: loaded.status, used: loaded.factors.length, problems: loaded.problems },
      ...result, unmeasured: read.unmeasured ?? {}, elements_read: read.elements_read ?? 0, notes,
    });
  } catch (error) {
    return gapReply({ ...stamp, refused: true, ...errorCode(error, "FMC-CARBON") }, true);
  }
}

export function registerFmcCarbonTool(server: McpServer) {
  server.tool("fmc_carbon", FMC_CARBON_DESCRIPTION, FMC_CARBON_SHAPE, async (args) => runFmcCarbon(args as FmcCarbonArgs));
}
