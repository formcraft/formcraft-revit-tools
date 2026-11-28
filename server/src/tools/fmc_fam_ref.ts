import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { refOps } from "../fmc/famedit.js";
import { CONFIRM_ARG, DRY_RUN_ARG, SESSION_ARG, famReply, famReport, runFamOps } from "./fam_common.js";

export const FMC_FAM_REF_DESCRIPTION =
  "Family editor: reference planes in an fmc_doc session (a thin wrapper over fmc_doc ops). list: each plane's id, name, Is Reference, " +
  "normal and position in mm. rename (plane_rename), move (plane_move: offset_mm along the plane's own normal; dimensions and locks follow " +
  "or Revit says why not), delete (plane_delete) by name or id. Center (Left/Right), Center (Front/Back), Ref. Level and planes that define " +
  "the origin are never renamed, moved or deleted. delete needs a person: the dry run lists what goes with the plane (dimensions, locks) and " +
  "answers a confirm_token; dry_run false with it only queues it for a person's Approve in the Formcraft pane, which runs it.";

export const FMC_FAM_REF_SHAPE = {
  action: z.enum(["list", "rename", "move", "delete"]),
  session: SESSION_ARG,
  name: z.string().optional().describe("the plane's name (or give id)"),
  id: z.number().int().positive().optional().describe("the plane's element id, from list (for an unnamed plane)"),
  new_name: z.string().optional().describe("rename: the new name"),
  offset_mm: z.number().finite().optional().describe("move: mm along the plane's normal (minus for the other way)"),
  dry_run: DRY_RUN_ARG,
  confirm_token: CONFIRM_ARG,
};
export type FmcFamRefArgs = z.infer<z.ZodObject<typeof FMC_FAM_REF_SHAPE>>;

export async function runFmcFamRef(a: FmcFamRefArgs) {
  if (a.action === "list") {
    const r = await famReport(a.session);
    if (!r.ok) return famReply({ error: r.error }, true);
    return famReply({ session: a.session, family: r.document.title ?? "", planes: r.document.planes ?? (r.document.reference_planes ?? []).map((n: string) => ({ name: n })) });
  }
  return runFamOps("fmc_fam_ref", a.session, refOps(a), a.dry_run !== false, a.confirm_token);
}

export function registerFmcFamRefTool(server: McpServer) {
  server.tool("fmc_fam_ref", FMC_FAM_REF_DESCRIPTION, FMC_FAM_REF_SHAPE, (args) => runFmcFamRef(args));
}
