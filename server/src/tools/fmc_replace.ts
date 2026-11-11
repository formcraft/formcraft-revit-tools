import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
  B3_BEAM_1666251_ROW, B7_NEW_CF1_ROW, REPLACE_DELETION_PASS, REPLACE_ROWS, REPLACE_TRANSACTION_MODEL, REPLACE_TRANSACTION_REASON,
} from "../fmc/replace.js";

export const FMC_REPLACE_DESCRIPTION =
  "Preview a structural replacement on a detached copy opened by fmc_file open_copy. Refuses an original, a live model, a protected path, a link, and an ambiguous document. " +
  REPLACE_TRANSACTION_REASON + " " +
  `The result's transaction.model is "${REPLACE_TRANSACTION_MODEL}" and transaction.deletion is "${REPLACE_DELETION_PASS}". ` +
  "Each row reports pass, fail or not_run for create, verify, rebind, delete and orphans, with the readback, the dependant inventory, rebind results, the ids Revit deleted and the orphan findings. " +
  "The group reports element counts per category before and after rollback, and that every old id is still present. committed, saved, synced and relinquished are false. " +
  "There is no apply flag. A keynote must be set on the new element at creation, in the form X.YYY_ZZ (for example S.FND_01); a missing or invalid keynote fails that row. " +
  "type_id and level_id are exact element ids. " +
  "Rebind covers rebar host, rebar container, geometry joins (including cut order), column base and top attachments, and analytical association. " +
  "A hosted family, area or path reinforcement, fabric, an opening, or an annotation that cannot be rebound fails the row unless its id is listed in expected_deleted_ids. " +
  "One call is one batch. B7 and B3 are two calls: a rolled-back B7 preview is not visible to B3. " +
  `Example foundation (B7:NEW-01, type_id and level_id stand in until a read of the copy): ${JSON.stringify(B7_NEW_CF1_ROW)}. ` +
  `Example beam (B3:1666251): ${JSON.stringify(B3_BEAM_1666251_ROW)}.`;

const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

export function registerFmcReplaceTool(server: McpServer) {
  server.tool("fmc_replace", FMC_REPLACE_DESCRIPTION, {
    document: z.string().refine((p) => /[\\/]/.test(p) && p.toLowerCase().endsWith(".rvt"), "document must be the copy's full .rvt path").describe("Full path of the document fmc_file open_copy opened. Required. A title, the active document, an original and a live path are refused."),
    tolerance_mm: z.number().positive().max(50).optional().default(2).describe("Geometry tolerance in millimetres for every check that does not set its own. Default 2."),
    rows: REPLACE_ROWS.describe("The batch, in dependency order. One TransactionGroup, always rolled back."),
  }, async (args) => {
    try {
      const result = await withRevitConnection((c) => c.sendCommand("fmc_replace", {
        document: args.document,
        tolerance_mm: args.tolerance_mm,
        rows: args.rows,
      }, 600000)) as { group?: { status?: string; rollback?: { proof?: boolean } }; error?: string };
      const proofFailed = result?.group?.rollback?.proof === false;
      return reply(result, proofFailed || !!result?.error);
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : String(e) }, true);
    }
  });
}
