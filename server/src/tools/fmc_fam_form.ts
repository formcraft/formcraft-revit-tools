// FE-02 fmc_fam_form: solid and void forms in a family, swept blends and lofts included, as fmc_doc ops.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FAM_COMMON, FORM_OPS, FamIo, famReply, famRun, formOps, realIo } from "../fmc/famtools.js";

export const FMC_FAM_FORM_DESCRIPTION =
  "Forms in a family, FE-02, through an fmc_doc session. forms: extrusion, void_extrusion, sweep, void_sweep, revolution, blend, " +
  "array (fmc_doc's own ops, same arguments), swept_blend and void_swept_blend (a straight path [[x,y,z],[x,y,z]] mm, a bottom and " +
  "a top closed profile [u,v] mm square to it), and loft {name, sections: [{z, outline}], subcategory} drawn as one blend per pair " +
  "of sections. Each form is named and answers create, update or skip, so a second run changes nothing. A dry run unless dry_run " +
  "is false (without a session: the planned ops only); save_path saves into the family staging root, and an existing file is " +
  "archived to _Archive first (overwrite: true).";

export const FMC_FAM_FORM_SHAPE = {
  ...FAM_COMMON,
  forms: z.array(z.object({ op: z.string().min(1) }).passthrough()).min(1)
    .describe(`the forms, in order: ${[...FORM_OPS, "loft"].join(", ")}`),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_FORM_SHAPE>>;

export async function runFmcFamForm(args: Args, io?: FamIo) {
  const x = io ?? await realIo();
  const plan = formOps(args.forms as Array<Record<string, unknown>>);
  if (plan.problems.length) return famReply({ refused: true, reasons: plan.problems });
  return famReply(await famRun("fmc_fam_form", { ops: plan.ops, notes: plan.notes }, args, x));
}

export function registerFmcFamFormTool(server: McpServer) {
  server.tool("fmc_fam_form", FMC_FAM_FORM_DESCRIPTION, FMC_FAM_FORM_SHAPE, (args) => runFmcFamForm(args as Args));
}
