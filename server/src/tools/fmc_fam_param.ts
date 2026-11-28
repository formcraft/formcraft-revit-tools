import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GROUPS } from "../fmc/ops.js";
import { paramOps } from "../fmc/famedit.js";
import { CONFIRM_ARG, DRY_RUN_ARG, SESSION_ARG, famReply, famReport, runFamOps } from "./fam_common.js";

export const FMC_FAM_PARAM_DESCRIPTION =
  "Family editor: family parameters in an fmc_doc session (a thin wrapper over fmc_doc ops). list: each parameter's name, instance/type, " +
  "shared GUID, group, reporting and formula. rename (param_rename; never a kit shared parameter), regroup (param_regroup), reporting " +
  "(param_set_reporting on/off), formula (param_set_formula; null clears it). remove (param_remove) needs a person: the dry run shows what goes " +
  "with it and answers a confirm_token; dry_run false with that token only queues it for a person's Approve in the Formcraft pane, which runs it. " +
  "Every write is a dry run unless dry_run is false. Nothing is saved: fmc_doc save does that.";

export const FMC_FAM_PARAM_SHAPE = {
  action: z.enum(["list", "rename", "regroup", "reporting", "formula", "remove"]),
  session: SESSION_ARG,
  name: z.string().optional().describe("the family parameter"),
  new_name: z.string().optional().describe("rename: the new name"),
  group: z.enum(GROUPS).optional().describe("regroup: the Properties group"),
  on: z.boolean().optional().describe("reporting: true makes it reporting, false driving"),
  formula: z.string().nullable().optional().describe("formula: the formula; null or \"\" clears it"),
  dry_run: DRY_RUN_ARG,
  confirm_token: CONFIRM_ARG,
};
export type FmcFamParamArgs = z.infer<z.ZodObject<typeof FMC_FAM_PARAM_SHAPE>>;

export async function runFmcFamParam(a: FmcFamParamArgs) {
  if (a.action === "list") {
    const r = await famReport(a.session);
    if (!r.ok) return famReply({ error: r.error }, true);
    return famReply({ session: a.session, family: r.document.title ?? "", parameters: r.document.parameter_detail ?? r.document.parameters ?? [] });
  }
  return runFamOps("fmc_fam_param", a.session, paramOps(a), a.dry_run !== false, a.confirm_token);
}

export function registerFmcFamParamTool(server: McpServer) {
  server.tool("fmc_fam_param", FMC_FAM_PARAM_DESCRIPTION, FMC_FAM_PARAM_SHAPE, (args) => runFmcFamParam(args));
}
