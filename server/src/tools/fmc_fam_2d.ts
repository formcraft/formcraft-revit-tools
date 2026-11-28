// FE-03 fmc_fam_2d: masking and filled regions, detail lines, symbolic lines, model lines and model text in a family, as fmc_doc ops.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FAM_COMMON, FamIo, TWO_D_OPS, famReply, famRun, realIo, twoDOps } from "../fmc/famtools.js";

export const FMC_FAM_2D_DESCRIPTION =
  "2D in a family, FE-03, through an fmc_doc session. items: masking_region (Revit 2024 or later) and filled_region " +
  "{name, view plan|front|right|annotation, points: closed outline mm, region_type}, detail_lines {name, view, points, closed, line_style}, " +
  "symbolic_lines (fmc_doc's own op, with coarse/medium/fine), model_lines {name, plane plan|front|right, at, points, closed, subcategory} " +
  "and model_text {name, text, plane, at, point, depth_mm, align, type_name, subcategory}, both with coarse/medium/fine and " +
  "plan_rcp/front_back/left_right visibility, and add_subcategory for line subcategories (FAM-044: black or dark grey lines, the " +
  "rule's pens). Regions and detail lines show only in their own view: visibility flags on them are refused (the API has none). " +
  "Each is named and answers create, update or skip. A dry run unless dry_run is " +
  "false (without a session: the planned ops only); save_path saves into the family staging root, and an existing file is archived " +
  "to _Archive first (overwrite: true).";

export const FMC_FAM_2D_SHAPE = {
  ...FAM_COMMON,
  items: z.array(z.object({ op: z.string().min(1) }).passthrough()).min(1).describe(`the 2D ops, in order: ${TWO_D_OPS.join(", ")}`),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_2D_SHAPE>>;

export async function runFmcFam2d(args: Args, io?: FamIo) {
  const x = io ?? await realIo();
  const plan = twoDOps(args.items as Array<Record<string, unknown>>);
  if (plan.problems.length) return famReply({ refused: true, reasons: plan.problems });
  return famReply(await famRun("fmc_fam_2d", { ops: plan.ops }, args, x));
}

export function registerFmcFam2dTool(server: McpServer) {
  server.tool("fmc_fam_2d", FMC_FAM_2D_DESCRIPTION, FMC_FAM_2D_SHAPE, (args) => runFmcFam2d(args as Args));
}
