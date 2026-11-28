import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { planGrids } from "../fmc/grids.js";

export const FMC_GRIDS_DESCRIPTION =
  "Copy the grids of one loaded Revit link into the host document. Same names, and the same line (its own two ends) or arc, moved by that " +
  "link instance's total transform and laid flat; a copied grid keeps the link grid's vertical extents. The reply lists each grid's length_mm. " +
  "action links lists the host's Revit link instances (the id to pass as link, name, path, loaded, pinned): read-only, no lease. " +
  "names limits the copy to those grid names. A grid whose name is already in the host " +
  "is skipped and reported; the same name at the same position is left as it is. dry_run defaults to true and creates nothing. " +
  "The Revit API has no method that creates a Copy/Monitor relationship, so these grids are not monitored. A person can add " +
  "monitoring with Copy/Monitor in the Revit UI. The caller does not supply code. This is a write: the batch lease, the " +
  "live-model lock, and the keynote and reference checks apply, the same as any other model change. The reply is a count of " +
  "created and skipped grids plus their ids, not the geometry.";

const shape = {
  action: z.enum(["copy", "links"]).optional().default("copy").describe("copy (default) copies grids; links lists the host's link instances and their ids"),
  document: z.string().min(1).describe("Title or full path of the open host model. The active document is not assumed."),
  link: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional().describe("copy: element id of the Revit link instance whose grids are copied (action links shows it). A link type id is not enough: the transform belongs to the instance."),
  names: z.array(z.string().min(1).max(80)).max(200).optional().describe("Copy only these grid names. Omit to copy every grid in the link."),
  dry_run: z.boolean().optional().default(true).describe("Report what would be created and skipped. Nothing is created. Default true."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** action links: the host's Revit link instances, from the read-only fmc_link_facts (no script, no lease). */
export async function listGridLinks(document: string, read?: (document: string) => Promise<unknown>) {
  try {
    const facts = asRecord(await (read
      ? read(document)
      : withRevitConnection((client) => client.sendRaw("fmc_link_facts", { document }, 60000))));
    const inner = asRecord(facts && "result" in facts ? facts.result : facts) ?? {};
    const links = (Array.isArray(inner.links) ? inner.links : []).map((raw) => {
      const l = asRecord(raw) ?? {};
      return { link: l.id, name: l.name ?? "", path: l.path ?? "", loaded: l.loaded === true, pinned: l.pinned === true, status: l.status ?? "" };
    });
    return reply({
      ok: true, action: "links", read_only: true, document, links,
      next: links.some((l) => l.loaded)
        ? "fmc_grids_from_link with link set to a loaded link's id (dry_run true first)"
        : "No loaded link: a person loads it in Manage Links (or fmc_links), then copy",
    });
  } catch (error) {
    return reply({ ok: false, action: "links", message: error instanceof Error ? error.message : String(error), document }, true);
  }
}

export async function runGridsFromLink(args: { action?: "copy" | "links"; document: string; link?: number | string; names?: string[]; dry_run?: boolean }, send?: (params: Record<string, unknown>) => Promise<unknown>, read?: (document: string) => Promise<unknown>) {
  if (args.action === "links") return listGridLinks(String(args.document ?? "").trim(), read);
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
      lengths: row.lengths ?? [],
      ...(row.extents_kept === false ? { note: "Some grids kept Revit's default vertical extents: set them by hand." } : {}),
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
