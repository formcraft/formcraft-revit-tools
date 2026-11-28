// FE-04 fmc_fam_light: a lighting family's light source (shape, distribution, lumens, colour temperature), as fmc_doc ops.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FAM_COMMON, FamIo, famReply, famRun, lightOps, realIo } from "../fmc/famtools.js";

export const FMC_FAM_LIGHT_DESCRIPTION =
  "Light source in a lighting family, FE-04 (from the kit's family light source script), through an fmc_doc session. Sets the " +
  "category to Lighting Fixtures (unless ensure_category is false), turns Light Source on, makes each family type's light type, " +
  "and sets shape, distribution, initial intensity in lumens (one for all types, or lumens_by_type by type name or prefix), colour " +
  "temperature in K, spot beam and field angles, and the source height. Only what differs is changed, so a second run answers skip. " +
  "A dry run unless dry_run is false (without a session: the planned ops only); save_path saves into the family staging root, and " +
  "an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_LIGHT_SHAPE = {
  ...FAM_COMMON,
  name: z.string().optional().default("Light source"),
  shape: z.enum(["point", "line", "rectangle", "circle"]).optional().default("point"),
  distribution: z.enum(["spherical", "hemispherical", "spot"]).optional().default("hemispherical"),
  lumens: z.number().positive().optional().describe("initial intensity of every light type, lm"),
  lumens_by_type: z.record(z.string(), z.number().positive()).optional().describe("lm by family type name (or name prefix)"),
  kelvin: z.number().min(1000).max(20000).optional().default(3000),
  beam_deg: z.number().positive().max(179).optional().describe("spot only"),
  field_deg: z.number().positive().max(179).optional().describe("spot only, at least the beam angle"),
  source_z_mm: z.number().finite().optional().describe("the light source's height in the family, mm"),
  ensure_category: z.boolean().optional().default(true),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_LIGHT_SHAPE>>;

export async function runFmcFamLight(args: Args, io?: FamIo) {
  const x = io ?? await realIo();
  return famReply(await famRun("fmc_fam_light", { ops: lightOps(args) }, args, x));
}

export function registerFmcFamLightTool(server: McpServer) {
  server.tool("fmc_fam_light", FMC_FAM_LIGHT_DESCRIPTION, FMC_FAM_LIGHT_SHAPE, (args) => runFmcFamLight(args as Args));
}
