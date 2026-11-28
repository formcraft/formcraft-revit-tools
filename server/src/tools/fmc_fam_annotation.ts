// FE-05 fmc_fam_annotation: tag, generic annotation, title block and detail component families, as fmc_doc ops.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ANNOTATION_KINDS, DRAW_OPS, FAM_COMMON, FamIo, annotationOps, famReply, famRun, realIo } from "../fmc/famtools.js";

export const FMC_FAM_ANNOTATION_DESCRIPTION =
  "Annotation-type families, FE-05: tag (tag_category, e.g. Door Tags), annotation (Generic Annotations), title_block (Title Blocks) " +
  "and detail_component (Detail Items), new from a template (template) or in an open session. Sets the category, prepares the label " +
  "parameters (label_params: each checked against the kit dictionary; added as kit shared parameters in annotation and title block " +
  "families; listed for tags, which read the tagged element) and draws: detail_lines, filled_region, masking_region and text_note " +
  "(in the family's view unless view is given), symbolic_lines. Labels are placed by a person: label_plan says which and where. " +
  "A dry run unless dry_run is false (without a session or template: the planned ops only); save_path saves into the family staging " +
  "root, and an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_ANNOTATION_SHAPE = {
  ...FAM_COMMON,
  kind: z.enum(ANNOTATION_KINDS),
  tag_category: z.string().optional().describe("tag: the category it tags, e.g. Door Tags"),
  label_params: z.array(z.string().min(1)).optional().describe("parameters the labels will show"),
  draw: z.array(z.object({ op: z.string().min(1) }).passthrough()).optional().describe(`drawing ops: ${DRAW_OPS.join(", ")}`),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_ANNOTATION_SHAPE>>;

export async function runFmcFamAnnotation(args: Args, io?: FamIo) {
  const x = io ?? await realIo();
  const plan = annotationOps(args as Parameters<typeof annotationOps>[0], x.dictionary);
  if (plan.problems.length) return famReply({ refused: true, reasons: plan.problems, label_plan: plan.label_plan });
  return famReply(await famRun("fmc_fam_annotation", { ops: plan.ops, notes: plan.notes, extra: { label_plan: plan.label_plan } }, args, x));
}

export function registerFmcFamAnnotationTool(server: McpServer) {
  server.tool("fmc_fam_annotation", FMC_FAM_ANNOTATION_DESCRIPTION, FMC_FAM_ANNOTATION_SHAPE, (args) => runFmcFamAnnotation(args as Args));
}
