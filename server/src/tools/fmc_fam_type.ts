import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { matrixSummary, typeOps } from "../fmc/famedit.js";
import { CONFIRM_ARG, DRY_RUN_ARG, SESSION_ARG, famReply, famReport, runFamOps } from "./fam_common.js";

export const FMC_FAM_TYPE_DESCRIPTION =
  "Family editor: family types in an fmc_doc session (a thin wrapper over fmc_doc ops). list: the types. rename (type_rename). flex_matrix " +
  "(type_flex_matrix, a read: each type is regenerated with each parameter at `steps` values from low to high, and every failure is listed; " +
  "nothing is kept or saved). delete (type_delete; never the last type) needs a person: the dry run answers a confirm_token; dry_run false " +
  "with it only queues the delete for a person's Approve in the Formcraft pane, which runs it. Writes are dry runs unless dry_run is false.";

const RANGE = z.object({ low: z.number(), high: z.number(), steps: z.number().int().min(2).max(6).optional() });
export const FMC_FAM_TYPE_SHAPE = {
  action: z.enum(["list", "rename", "flex_matrix", "delete"]),
  session: SESSION_ARG,
  name: z.string().optional().describe("the type"),
  new_name: z.string().optional().describe("rename: the new name"),
  params: z.array(z.string().min(1)).optional().describe("flex_matrix: the parameters to flex"),
  ranges: z.record(RANGE).optional().describe("flex_matrix: per parameter { low, high, steps? } (Length mm, Angle degrees)"),
  types: z.array(z.string().min(1)).optional().describe("flex_matrix: only these types (default every type)"),
  dry_run: DRY_RUN_ARG,
  confirm_token: CONFIRM_ARG,
};
export type FmcFamTypeArgs = z.infer<z.ZodObject<typeof FMC_FAM_TYPE_SHAPE>>;

export async function runFmcFamType(a: FmcFamTypeArgs) {
  if (a.action === "list") {
    const r = await famReport(a.session);
    if (!r.ok) return famReply({ error: r.error }, true);
    return famReply({ session: a.session, family: r.document.title ?? "", types: r.document.types ?? [] });
  }
  const r = await runFamOps("fmc_fam_type", a.session, typeOps(a), a.action === "flex_matrix" ? true : a.dry_run !== false, a.confirm_token);
  if (a.action !== "flex_matrix" || r.isError) return r;
  try {
    const body = JSON.parse(r.content[0].text);
    const m = (body.ops ?? []).find((o: { op: string }) => o.op === "type_flex_matrix");
    const matrix = m?.matrix ?? null;
    return famReply({ ...body, matrix, ...(matrix ? matrixSummary(matrix) : {}) });
  } catch { return r; }
}

export function registerFmcFamTypeTool(server: McpServer) {
  server.tool("fmc_fam_type", FMC_FAM_TYPE_DESCRIPTION, FMC_FAM_TYPE_SHAPE, (args) => runFmcFamType(args));
}
