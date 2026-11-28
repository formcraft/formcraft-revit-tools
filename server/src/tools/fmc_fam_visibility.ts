// B15 fmc_fam_visibility: per-element visibility in a family (detail levels, views, only when cut, Visible parameter, tiers).
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FAM_B15_COMMON, FamB15Io, TIERS, VIS_OPS, famB15Reply, famB15Run, itemsShape, realB15Io, visibilityOps } from "../fmc/famb15.js";

export const FMC_FAM_VISIBILITY_DESCRIPTION =
  "Visibility of a family's elements, through one fmc_doc apply. items: vis_set {name, element_ids | targets (op names; default " +
  "the name), detail_levels: [coarse, medium, fine] it shows in, or tier: " + Object.keys(TIERS).join(" | ") + ", views: [plan_rcp, " +
  "front_back, left_right], only_when_cut, param: a Yes/No parameter its Visible follows}, set_visibility and set_visible_param " +
  "(fmc_doc's own), vis_matrix (read-only). A vis_matrix runs last unless matrix is false: every element's levels and views, and " +
  "a warning with the fix for detail levels nothing shows in. " +
  "A dry run unless dry_run is false (without a session: the planned ops only); save_path saves into the family staging root, " +
  "and an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_VISIBILITY_SHAPE = {
  ...FAM_B15_COMMON,
  items: itemsShape(VIS_OPS),
  matrix: z.boolean().optional().default(true).describe("add a visibility_matrix check at the end (default true)"),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_VISIBILITY_SHAPE>>;

export async function runFmcFamVisibility(args: Args, io?: FamB15Io) {
  const x = io ?? await realB15Io();
  return famB15Reply(await famB15Run("fmc_fam_visibility", visibilityOps(args.items as Array<Record<string, unknown>>, args.matrix !== false), args, x));
}

export function registerFmcFamVisibilityTool(server: McpServer) {
  server.tool("fmc_fam_visibility", FMC_FAM_VISIBILITY_DESCRIPTION, FMC_FAM_VISIBILITY_SHAPE, (args) => runFmcFamVisibility(args as Args));
}
