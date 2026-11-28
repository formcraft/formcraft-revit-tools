import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { normalizeIds, normalizeOptionalId, normalizeReply } from "../fmc/visibility.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_VISIBILITY_DESCRIPTION =
  "Formcraft: explains WHY elements are or are not visible in one view. Read only: no transaction, nothing is hidden, " +
  "unhidden, isolated, overridden or saved, and suggested fixes are text only (never applied). Give element_ids (1 to 50) and " +
  "view_id (omit for the active view of the document on screen). For each element it returns visible yes, no or unknown, " +
  "and every reason that applies, in this order, each with evidence and a fix: hidden in view (element hidden, temporary " +
  "hide/isolate), category and subcategory hidden, view filters (visibility off, or 100% transparent), view template, " +
  "workset hidden, design option not shown, phase and phase filter, crop region, view range (plan), section box (3D), far clip " +
  "(sections), detail level (best effort), linked model settings, view-specific element owned by another view, discipline, " +
  "underlay, and Revit's own verdict (the view's element collector). A check that cannot decide is reported as unknown with " +
  "the reason, never skipped; one that does not apply is listed under not_applicable. For an element that lives in a Revit " +
  "link, pass link_instance_id (the link instance in the host) and the element's id inside the link: filters, workset, " +
  "design option, phase and detail level are then reported unknown, not guessed. " +
  "Example: element_ids [\"1234567\"], view_id \"89012\", document F26901-FMC-ZZ-ZZ-M3-A-0002_USER.";

export const FMC_VISIBILITY_SHAPE = {
  element_ids: z.array(z.union([z.string(), z.number()])).min(1).max(50).describe("1 to 50 element ids"),
  view_id: z.union([z.string(), z.number()]).optional().describe("The view's id. Omit for the active view of the document on screen."),
  document: z.string().optional().default("").describe("The model's title or full path. Omit for the active document."),
  link_instance_id: z.union([z.string(), z.number()]).optional().describe("The Revit link instance, when the element ids are ids inside that link."),
};

export type FmcVisibilityArgs = z.infer<z.ZodObject<typeof FMC_VISIBILITY_SHAPE>>;

export interface VisibilityIo {
  send?: (body: Record<string, unknown>) => Promise<unknown>;
}

function refuse(code: string, message: string) {
  return reply({ tool: "fmc_visibility", model_changed: false, fixes_applied: false, refused: true, code, message }, true);
}

export async function runFmcVisibility(args: FmcVisibilityArgs, io: VisibilityIo = {}) {
  try {
    const ids = normalizeIds(args.element_ids);
    if (ids.problem) return refuse("FMC-VIS-IDS", ids.problem);
    const view = normalizeOptionalId(args.view_id, "view_id");
    if (view.problem) return refuse("FMC-VIS-VIEW", view.problem);
    const link = normalizeOptionalId(args.link_instance_id, "link_instance_id");
    if (link.problem) return refuse("FMC-VIS-LINK", link.problem);
    const send = io.send ?? ((body: Record<string, unknown>) => withRevitConnection((client) => client.sendCommand("fmc_visibility", body, 60000)));
    const body: Record<string, unknown> = { element_ids: ids.ids };
    if (view.id) body.view_id = view.id;
    if (link.id) body.link_instance_id = link.id;
    if (args.document.trim()) body.document = args.document.trim();
    const raw = await send(body);
    const checked = normalizeReply(raw, ids.ids);
    if (!checked.ok) return refuse("FMC-VIS-BAD-REPLY", checked.message);
    return reply(checked.reply);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-VIS", message);
  }
}

export function registerFmcVisibilityTool(server: McpServer) {
  server.tool("fmc_visibility", FMC_VISIBILITY_DESCRIPTION, FMC_VISIBILITY_SHAPE, async (args) => runFmcVisibility(args as FmcVisibilityArgs));
}
