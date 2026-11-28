// B15 fmc_fam_dim: dimensions in a family (linear, EQ, angular, radial, diameter; label; unlock), as fmc_doc ops.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DIM_OPS, FAM_B15_COMMON, FamB15Io, dimOps, famB15Reply, famB15Run, itemsShape, realB15Io } from "../fmc/famb15.js";

export const FMC_FAM_DIM_DESCRIPTION =
  "Dimensions in a family, through one fmc_doc apply. items: add_dimension {name, between: [plane, plane], label} and " +
  "add_eq_dimension {name, planes} (fmc_doc's own), dim_add_angular {name, refs: two crossing planes, label: an Angle parameter, " +
  "view, radius}, dim_add_radial {name, ref: a named solid's circular edge or line set's arc, label: a Length parameter, diameter, " +
  "arc_index} (dim_add_diameter: the same with diameter), dim_unlock {name, id | refs | label}: its detail lists the planes that " +
  "then float. Each op answers create, update or skip. " +
  "A dry run unless dry_run is false (without a session: the planned ops only); save_path saves into the family staging root, " +
  "and an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_DIM_SHAPE = { ...FAM_B15_COMMON, items: itemsShape(DIM_OPS) };
type Args = z.infer<z.ZodObject<typeof FMC_FAM_DIM_SHAPE>>;

export async function runFmcFamDim(args: Args, io?: FamB15Io) {
  const x = io ?? await realB15Io();
  return famB15Reply(await famB15Run("fmc_fam_dim", dimOps(args.items as Array<Record<string, unknown>>), args, x));
}

export function registerFmcFamDimTool(server: McpServer) {
  server.tool("fmc_fam_dim", FMC_FAM_DIM_DESCRIPTION, FMC_FAM_DIM_SHAPE, (args) => runFmcFamDim(args as Args));
}
