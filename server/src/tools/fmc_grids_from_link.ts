import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { planGrids } from "../fmc/grids.js";

export const FMC_GRIDS_DESCRIPTION =
  "Copy the grids of one loaded Revit link into the host document. Same names, and the same line or arc, moved by that " +
  "link instance's total transform. names limits the copy to those grid names. A grid whose name is already in the host " +
  "is skipped and reported; the same name at the same position is left as it is. dry_run defaults to true and creates nothing. " +
  "The Revit API has no method that creates a Copy/Monitor relationship, so these grids are not monitored. A person can add " +
  "monitoring with Copy/Monitor in the Revit UI. The caller does not supply code. This is a write: the batch lease, the " +
  "live-model lock, and the keynote and reference checks apply, the same as any other model change. The reply is a count of " +
  "created and skipped grids plus their ids, not the geometry.";

const shape = {
  document: z.string().min(1).describe("Title or full path of the open host model. The active document is not assumed."),
  link: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).describe("Element id of the Revit link instance whose grids are copied. A link type id is not enough: the transform belongs to the instance."),
  names: z.array(z.string().min(1).max(80)).max(200).optional().describe("Copy only these grid names. Omit to copy every grid in the link."),
  dry_run: z.boolean().optional().default(true).describe("Report what would be created and skipped. Nothing is created. Default true."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function runGridsFromLink(args: { document: string; link: number | string; names?: string[]; dry_run?: boolean }, send?: (params: Record<string, unknown>) => Promise<unknown>) {
  const plan = planGrids(args);
  if (!plan.ok || !plan.params) return reply({ ok: false, refused: true, reasons: plan.reasons, document: plan.document }, true);
  try {
    const response = asRecord(await (send
      ? send(plan.params)
      : withRevitConnection((client) => client.sendCommand("fmc_grids_from_link", plan.params, 300000))));
    let result: unknown = response && "result" in response ? response.result : response;
    if (typeof result === "string") {
      try { result = JSON.parse(result); } catch { /* keep the text */ }
    }
    const row = asRecord(result) ?? {};
    if (response?.success === false || row.ok === false) {
      const message = String(response?.errorMessage || response?.error || row.message || "The grids were not copied.");
      return reply({ ok: false, message, document: plan.document, dry_run: plan.dry_run }, true);
    }
    return reply({
      ok: true,
      dry_run: plan.dry_run,
      created: row.created ?? 0,
      skipped: row.skipped ?? 0,
      ids: row.ids ?? [],
      names: row.names ?? [],
      skipped_names: row.skipped_names ?? [],
      monitored: false,
      document: plan.document,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, message, document: plan.document }, true);
  }
}

export function registerFmcGridsFromLinkTool(server: McpServer) {
  server.tool("fmc_grids_from_link", FMC_GRIDS_DESCRIPTION, shape, (args) => runGridsFromLink(args));
}
