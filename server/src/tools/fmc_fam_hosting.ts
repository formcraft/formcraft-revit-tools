import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expandEnv } from "../fmc/policy.js";
import { FamEditIo, Reply, applyFamily, errorText, famLog, gateProblems, makeCtx, nextStep, readFamily } from "../fmc/famedit_common.js";
import { HostingRead, planHosting, rebuildPlan } from "../fmc/famhost_plan.js";

export const FMC_FAM_HOSTING_DESCRIPTION =
  "Formcraft family editor: a family's hosting, in a family document (never a project). read: the host (none, wall, floor, " +
    "ceiling, roof, face), placement type, Work Plane-Based and Always Vertical, whether it is adaptive or a conceptual mass, " +
    "its reference and adaptive points, instance parameters, solids and voids (read only). convert to face_based, " +
    "work_plane_based or adaptive: what the API can change in place is done in one transaction (Work Plane-Based and Always " +
    "Vertical on an unhosted family; reference points made adaptive placement points in a conceptual mass or adaptive family); " +
    "the dry run is that change rolled back. Revit fixes a family's host from its template, so face-based (and adaptive from " +
    "a standard template) can't be converted in place: the dry run says so and gives the rebuild path instead (a new family " +
    "from the face-based or adaptive template with this one nested, its parameters associated, saved under a new name in " +
    "staging: the fmc_doc and fmc_fam_nested calls to run, the template checked on this PC, and what a rebuild loses), and a " +
    "real run is refused rather than faked. rebuild_plan: only the rebuild path. dry_run=false needs confirm=true (one Undo). " +
    "Every reply has a run_id (also in the file log).";

export const FMC_FAM_HOSTING_SHAPE = {
  action: z.enum(["read", "convert", "rebuild_plan"]),
  document: z.string().optional().default("").describe("The open family document: title or path (an fmc_doc session's document or a family open in Revit)"),
  to: z.enum(["face_based", "work_plane_based", "adaptive"]).optional().describe("convert, rebuild_plan: the hosting wanted"),
  always_vertical: z.boolean().optional().describe("convert to work_plane_based: also set Always Vertical"),
  points: z.array(z.number().int()).optional().describe("convert to adaptive: the reference point ids to make adaptive (default: every reference point that isn't yet)"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("convert: needed with dry_run=false, after the person has seen the dry run"),
};
export type FmcFamHostingArgs = z.infer<z.ZodObject<typeof FMC_FAM_HOSTING_SHAPE>>;

export async function runFmcFamHosting(args: FmcFamHostingArgs, io: FamEditIo = {}): Promise<Reply> {
  const ctx = makeCtx("fmc_fam_hosting", args, io);
  const change = args.action === "convert";
  try {
    const gate = gateProblems(ctx, change, "changes the family's hosting");
    if (args.action !== "read" && !args.to) gate.push(`${args.action} needs to: face_based, work_plane_based or adaptive`);
    if (gate.length) return ctx.reply({ refused: true, reasons: gate }, true);
    const read = await readFamily<HostingRead>(ctx, "fmc_fam_hosting_read");
    if (args.action === "read") return ctx.reply({ hosting: read });
    const templateDir = expandEnv(ctx.config.family_template_dir ?? "");
    if (args.action === "rebuild_plan") return ctx.reply({ to: args.to, current: read.hosting, rebuild: rebuildPlan(args.to!, read, templateDir, ctx.exists),
      next: "Each step is its own dry run first; this tool runs none of them" });
    const plan = planHosting(args.to!, read, { templateDir, exists: ctx.exists, points: args.points, always_vertical: args.always_vertical });
    if (plan.nothing_to_do) return ctx.reply({ dry_run: ctx.dry, nothing_to_do: true, plan });
    if (!plan.apply) {
      famLog(ctx.config, ctx.dry, ctx.document, ctx.dry ? "rebuild path" : "refused", `${args.to}: ${plan.why}`, "fam_hosting_convert", ctx.run_id);
      const body = { dry_run: ctx.dry, in_place: false, plan, next: plan.rebuild ? "Not convertible in place: run the rebuild steps (each a dry run first), or keep the family as it is" : "Fix what the plan says, then convert again" };
      return ctx.reply(ctx.dry ? body : { refused: true, reasons: [plan.why], ...body }, !ctx.dry);
    }
    const { result, outcome } = await applyFamily(ctx, "fmc_fam_hosting_apply", plan.apply, `${args.to} in place (${plan.apply.action})`, "fam_hosting_convert");
    return ctx.reply({ dry_run: ctx.dry, in_place: true, plan, result, next: nextStep(ctx, outcome) }, !!result?.failed);
  } catch (error) {
    famLog(ctx.config, ctx.dry, ctx.document || "(none)", "error", errorText(error), `fam_hosting_${args.action}`, ctx.run_id);
    return ctx.reply({ error: errorText(error) }, true);
  }
}

export function registerFmcFamHostingTool(server: McpServer) {
  server.tool("fmc_fam_hosting", FMC_FAM_HOSTING_DESCRIPTION, FMC_FAM_HOSTING_SHAPE, (args) => runFmcFamHosting(args));
}
