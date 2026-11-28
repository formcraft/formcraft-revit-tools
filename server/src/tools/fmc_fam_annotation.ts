// FE-05 fmc_fam_annotation: tag, generic annotation, title block and detail component families, as fmc_doc ops.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ANNOTATION_KINDS, DRAW_OPS, FAM_COMMON, FamIo, KEYNOTE_LABELS, REPEAT_LAYOUTS, annotationOps, famReply, famRun, realIo } from "../fmc/famtools.js";

export const FMC_FAM_ANNOTATION_DESCRIPTION =
  "Annotation-type families, FE-05: tag (tag_category, e.g. Door Tags), annotation (Generic Annotations), title_block (Title Blocks) " +
  "detail_component (Detail Items) and keynote_tag (Keynote Tags: labels Key Value, Keynote Text or Keynote Number only, Key Value " +
  "by default), new from a template (template) or in an open session. Sets the category, prepares the label " +
  "parameters (label_params: each checked against the kit dictionary; added as kit shared parameters in annotation and title block " +
  "families; listed for tags, which read the tagged element) and draws: detail_lines, filled_region, masking_region and text_note " +
  "(in the family's view unless view is given), symbolic_lines. Labels are placed by a person: label_plan says which and where. " +
  "detail_component: repeating_detail {layout, spacing_mm, number, inside, rotation} returns a repeat_plan, the values of the project's " +
  "Repeating Detail type that will use this family (set in the project by a person; never here). " +
  "A dry run unless dry_run is false (without a session or template: the planned ops only); save_path saves into the family staging " +
  "root, and an existing file is archived to _Archive first (overwrite: true).";

export const FMC_FAM_ANNOTATION_SHAPE = {
  ...FAM_COMMON,
  kind: z.enum(ANNOTATION_KINDS),
  tag_category: z.string().optional().describe("tag: the category it tags, e.g. Door Tags"),
  label_params: z.array(z.string().min(1)).optional().describe("parameters the labels will show"),
  draw: z.array(z.object({ op: z.string().min(1) }).passthrough()).optional().describe(`drawing ops: ${DRAW_OPS.join(", ")}`),
  repeating_detail: z.object({
    layout: z.enum(REPEAT_LAYOUTS),
    spacing_mm: z.number().positive().max(100000).optional().describe("fixed_distance and maximum_spacing"),
    number: z.number().int().min(2).max(1000).optional().describe("fixed_number"),
    inside: z.boolean().optional().describe("keep the components inside the drawn path (default true)"),
    rotation: z.enum(["none", "across"]).optional(),
  }).optional().describe("detail_component only: the repeating detail type's values, returned as repeat_plan"),
  family_name: z.string().optional().describe(`the family's name for repeat_plan; keynote_tag labels: ${KEYNOTE_LABELS.join(", ")}`),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_ANNOTATION_SHAPE>>;

export async function runFmcFamAnnotation(args: Args, io?: FamIo) {
  const x = io ?? await realIo();
  const plan = annotationOps(args as Parameters<typeof annotationOps>[0], x.dictionary);
  if (plan.problems.length) return famReply({ refused: true, reasons: plan.problems, label_plan: plan.label_plan });
  const extra = { label_plan: plan.label_plan, ...(plan.repeat_plan ? { repeat_plan: plan.repeat_plan } : {}) };
  return famReply(await famRun("fmc_fam_annotation", { ops: plan.ops, notes: plan.notes, extra }, args, x));
}

export function registerFmcFamAnnotationTool(server: McpServer) {
  server.tool("fmc_fam_annotation", FMC_FAM_ANNOTATION_DESCRIPTION, FMC_FAM_ANNOTATION_SHAPE, (args) => runFmcFamAnnotation(args as Args));
}
