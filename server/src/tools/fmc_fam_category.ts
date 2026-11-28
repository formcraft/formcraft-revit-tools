// B15 fmc_fam_category: family category and its parameters, subcategories add, rename, delete and graphics.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CAT_OPS, FAM_B15_COMMON, FamB15Io, categoryOps, famB15Reply, famB15Run, itemsShape, realB15Io } from "../fmc/famb15.js";

export const FMC_FAM_CATEGORY_DESCRIPTION =
  "A family's category and its parameters, through one fmc_doc apply. category sets it first (a Revit category name or OST_ " +
  "name). items: category_set {name, category?, subcategory?, element_ids | targets: moved onto the subcategory}, " +
  "set_family_params {name: family, work_plane_based, always_vertical, shared, room_calculation_point, part_type} (fmc_doc's " +
  "own), category_flags {name: family, cut_with_voids, can_host_rebar, ifc_export_as, ifc_predefined_type}, add_subcategory " +
  "{name, line_weight_projection, line_weight_cut, color, material} (adds or updates graphics), set_subcategory, " +
  "category_sub_rename {name, to}, category_sub_delete {name, reassign_to?}: one in use is refused with the elements that use it " +
  "unless reassign_to moves them first. " +
  "A dry run unless dry_run is false (without a session: the planned ops only); save_path saves into the family staging root, " +
  "and an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_CATEGORY_SHAPE = {
  ...FAM_B15_COMMON,
  category: z.string().optional().default("").describe("the family category, e.g. Furniture or OST_Furniture (set first)"),
  items: itemsShape(CAT_OPS).optional().default([]),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_CATEGORY_SHAPE>>;

export async function runFmcFamCategory(args: Args, io?: FamB15Io) {
  const x = io ?? await realB15Io();
  const plan = categoryOps((args.items ?? []) as Array<Record<string, unknown>>, args.category ?? "");
  if (!plan.ops.length) plan.problems.push("give a category or items");
  return famB15Reply(await famB15Run("fmc_fam_category", plan, args, x));
}

export function registerFmcFamCategoryTool(server: McpServer) {
  server.tool("fmc_fam_category", FMC_FAM_CATEGORY_DESCRIPTION, FMC_FAM_CATEGORY_SHAPE, (args) => runFmcFamCategory(args as Args));
}
