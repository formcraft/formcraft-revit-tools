// FE-01 fmc_fam_template: Formcraft family templates (.rft): list, audit, create a family with standard planes and parameters.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FAM_COMMON, FamIo, SIZE, auditTemplate, famReply, famRun, inspectTemplate, listTemplates, realIo, templateCreateOps } from "../fmc/famtools.js";

export const FMC_FAM_TEMPLATE_DESCRIPTION =
  "Family templates (.rft), FE-01. list (read-only): the .rft files in the template roots and the family template folder, " +
  "the kit's own (FMC_*) marked. inspect (read-only): opens the template in a background fmc_doc session, reports what it holds " +
  "(category, parameters, types, reference planes) and closes it without saving. audit (read-only): one template against the kit (inside the template roots, exists, .rft, named FMC_*). " +
  "create: a new family from the template (fmc_doc open) with the standard planes and parameters: category, skeleton " +
  "(Width/Depth/Height reference planes with labelled dimensions and an optional mounting height) and kit shared parameters by name " +
  "from the dictionary (by GUID). A dry run unless dry_run is false; save_path saves into the family staging root only, and an " +
  "existing file is archived to _Archive first (overwrite: true). Project templates (.rte) stay with fmc_template.";

export const FMC_FAM_TEMPLATE_SHAPE = {
  action: z.enum(["list", "inspect", "audit", "create"]),
  ...FAM_COMMON,
  category: z.string().optional().describe("create: the family's category, e.g. Furniture"),
  width: SIZE.optional(), depth: SIZE.optional(), height: SIZE.optional(), mounting: SIZE.optional(),
  shared_params: z.array(z.string().min(1)).optional().describe("create: kit shared parameters to add, by name"),
  instance_params: z.array(z.string().min(1)).optional().describe("create: which of shared_params are instance parameters"),
};
type Args = z.infer<z.ZodObject<typeof FMC_FAM_TEMPLATE_SHAPE>>;

export async function runFmcFamTemplate(args: Args, io?: FamIo) {
  const x = io ?? await realIo();
  if (args.action === "list") {
    const templates = listTemplates(x.config, x);
    return famReply({ templates, count: templates.length, formcraft: templates.filter((t) => t.formcraft).length });
  }
  if (!args.template?.trim()) return famReply({ refused: true, reasons: [`${args.action} needs a template (.rft)`] });
  const audit = auditTemplate(args.template, x.config, x);
  if (args.action === "audit") return famReply(audit);
  if (args.action === "inspect") {
    if (!audit.ok) return famReply({ refused: true, reasons: audit.problems });
    return famReply({ ...audit, ...(await inspectTemplate(audit.template, x)) });
  }
  if (!audit.ok) return famReply({ refused: true, reasons: audit.problems });
  if (args.session?.trim()) return famReply({ refused: true, reasons: ["create opens a new family from the template; leave session out"] });
  const plan = templateCreateOps(args, x.dictionary);
  return famReply(await famRun("fmc_fam_template", { ops: plan.ops, notes: [...audit.notes, ...plan.notes] }, args, x));
}

export function registerFmcFamTemplateTool(server: McpServer) {
  server.tool("fmc_fam_template", FMC_FAM_TEMPLATE_DESCRIPTION, FMC_FAM_TEMPLATE_SHAPE, (args) => runFmcFamTemplate(args as Args));
}
