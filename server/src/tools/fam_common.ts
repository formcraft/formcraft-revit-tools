/**
 * Shared by the family editor tools (fmc_fam_param, fmc_fam_type, fmc_fam_ref): they are thin wrappers that build fmc_doc
 * ops (fmc/famedit.ts) and run them through fmc_doc apply, so every check, the dry run and the delete gate are fmc_doc's.
 * A helper module (no register*Tool export).
 */
import { z } from "zod";
import { FMC_DOC_SHAPE, runFmcDoc } from "./fmc_doc.js";
import { Built } from "../fmc/famedit.js";

export const SESSION_ARG = z.string().min(1).describe("the fmc_doc session id (fmc_doc open on a family template or a staging .rfa)");
export const DRY_RUN_ARG = z.boolean().optional().default(true).describe("a dry run (the real run rolled back) unless false");
export const CONFIRM_ARG = z.string().optional().default("").describe("a delete with dry_run false: the confirm_token from its dry run. It only queues the delete for a person's Approve in the pane");

type Reply = { content: Array<{ type: "text"; text: string }>; isError: boolean };
export const famReply = (body: object, isError = false): Reply => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

/** Runs built ops through fmc_doc apply, tagged with the wrapper's name. */
export async function runFamOps(tool: string, session: string, built: Built, dryRun: boolean, confirmToken = ""): Promise<Reply> {
  if ("refused" in built) return famReply({ refused: true, tool, reasons: built.refused }, true);
  const args = z.object(FMC_DOC_SHAPE).parse({ action: "apply", session, ops: built.ops, dry_run: dryRun, confirm_token: confirmToken });
  const r = await runFmcDoc(args) as Reply;
  try { return { ...r, content: [{ type: "text" as const, text: JSON.stringify({ tool, ops_sent: built.ops, ...JSON.parse(r.content[0].text) }, null, 2) }] }; } catch { return r; }
}

/** fmc_doc report for a session, parsed: the list actions pick their part of it. */
export async function famReport(session: string): Promise<{ ok: boolean; document: Record<string, any>; error?: string }> {
  const r = await runFmcDoc(z.object(FMC_DOC_SHAPE).parse({ action: "report", session })) as Reply;
  try {
    const body = JSON.parse(r.content[0].text);
    return r.isError ? { ok: false, document: {}, error: body.error ?? (body.reasons ?? []).join("; ") } : { ok: true, document: body.document ?? {} };
  } catch (e) { return { ok: false, document: {}, error: e instanceof Error ? e.message : String(e) }; }
}
