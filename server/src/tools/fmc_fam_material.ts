// B15 fmc_fam_material: kit materials in a family: bring in, Material parameter, assign to a solid or a face, purge, texture check.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expandEnv } from "../fmc/policy.js";
import { FAM_B15_COMMON, FamB15Io, MAT_OPS, famB15Reply, famB15Run, itemsShape, materialOps, realB15Io, textureProblems } from "../fmc/famb15.js";

export const FMC_FAM_MATERIAL_DESCRIPTION =
  "Materials in a family, kit materials only (07_Materials\\FMC_Materials.json), through one fmc_doc apply. items: add_material " +
  "{name: an FMC_ material} brings one in from the kit, material_param {name: a Material parameter, solid, instance?} makes the " +
  "parameter and ties the solid's Material to it, set_material_param (fmc_doc's own), material_set {name, element_ids | targets | " +
  "param, material, detach?}, material_paint {name: <solid>/<face>, solid, face: top|bottom|left|right|front|back, material}, " +
  "material_purge {name, delete: false lists the unused ones only, keep}. Every texture of a kit material must be inside the kit's " +
  "materials folder (else refused) and on disk (else a warning). " +
  "A dry run unless dry_run is false (without a session: the planned ops only); save_path saves into the family staging root, " +
  "and an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_MATERIAL_SHAPE = { ...FAM_B15_COMMON, items: itemsShape(MAT_OPS) };
type Args = z.infer<z.ZodObject<typeof FMC_FAM_MATERIAL_SHAPE>>;

export async function runFmcFamMaterial(args: Args, io?: FamB15Io) {
  const items = args.items as Array<Record<string, unknown>>;
  const x = io ?? await realB15Io(items.some((i) => i.op === "add_material"));
  const plan = materialOps(items);
  const tex = textureProblems(plan.ops, x.materials, expandEnv(x.config.materials_file ?? ""), x.exists);
  plan.problems.push(...tex.errors);
  plan.notes.push(...tex.notes);
  return famB15Reply(await famB15Run("fmc_fam_material", plan, args, x));
}

export function registerFmcFamMaterialTool(server: McpServer) {
  server.tool("fmc_fam_material", FMC_FAM_MATERIAL_DESCRIPTION, FMC_FAM_MATERIAL_SHAPE, (args) => runFmcFamMaterial(args as Args));
}
