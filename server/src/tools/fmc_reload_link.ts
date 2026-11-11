import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { planReloadLink, type LinkHost } from "../fmc/reloadlink.js";

export const FMC_RELOAD_LINK_DESCRIPTION =
  "Reloads one Revit link type in a named open project. Pass document (a title or a full path) and link_type_id. " +
  "Pass path to load that file (LoadFrom); omit path to reload the link from where it is (Reload). " +
  "Link instances stay where they are. This is a write: it needs the batch lease, and the live-model lock applies. " +
  "A family, a verification copy, a linked document and a protected original are refused. " +
  "Needs the add-in: the reload runs in its own handler, which opens no transaction. " +
  "send_code_to_revit cannot do this: even transactionMode none still opens a transaction group, and Revit 2025 refuses the reload while that phase is open.";

const shape = {
  document: z.string().min(1).describe("Title or full path of the open project that holds the link. A family is refused."),
  link_type_id: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).describe("Element id of the Revit link type, not of a link instance."),
  path: z.string().optional().describe("Full path to load the link from. Omit to reload the link from its current path."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function runReloadLink(args: { document: string; link_type_id: number | string; path?: string }) {
  let host: LinkHost | null = null;
  try {
    const info = await withRevitConnection((client) => client.sendCommand("fmc_document_info", { document: args.document })) as { active?: LinkHost };
    host = info?.active ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const plan = planReloadLink(args, null);
    const document = plan.ok ? { title: args.document, path: "" } : plan.document;
    return reply({ ok: false, refused: true, message: `Could not read the open document, so the link was not reloaded. ${message}`, document }, true);
  }
  const plan = planReloadLink(args, host);
  if (!plan.ok) return reply({ ok: false, refused: true, message: plan.message, document: plan.document }, true);
  try {
    const result = asRecord(await withRevitConnection((client) => client.sendCommand("fmc_reload_link", plan.params, 300000)));
    const document = asRecord(result?.document) ?? { title: host?.title ?? args.document, path: host?.path ?? "" };
    return reply({ ok: true, ...(result ?? {}), document });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, message, document: { title: host?.title ?? args.document, path: host?.path ?? "" } }, true);
  }
}

export function registerFmcReloadLinkTool(server: McpServer) {
  server.tool("fmc_reload_link", FMC_RELOAD_LINK_DESCRIPTION, shape, (args) => runReloadLink(args));
}
