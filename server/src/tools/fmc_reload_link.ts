import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { judgeReload, planReloadLink, type LinkHost, type SessionDoc } from "../fmc/reloadlink.js";

export const FMC_RELOAD_LINK_DESCRIPTION =
  "Reloads one Revit link type in a named open project. Pass document (a title or a full path) and link_type_id. " +
  "Pass path to load that file (LoadFrom); omit path to reload the link from where it is (Reload). " +
  "Link instances stay where they are. This is a write: it needs the batch lease, and the live-model lock applies. " +
  "A family, a verification copy, a linked document and a protected original are refused. " +
  "Needs the add-in: the reload runs in its own handler, which opens no transaction. " +
  "send_code_to_revit cannot do this: even transactionMode none still opens a transaction group, and Revit 2025 refuses the reload while that phase is open. " +
  "A reply is success only when status is Loaded. LoadResult alone is not enough: the link can stay Unloaded.";

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

export interface ReloadIo {
  documentInfo(document: string): Promise<unknown>;
  reload(params: { document: string; link_type_id: number; path?: string }): Promise<unknown>;
  /** Read-only central of one open document. fmc_workshare_facts. Used only when the link did not load. */
  centralOf?(document: string): Promise<string>;
}

function sessionDocs(info: Record<string, unknown> | null): SessionDoc[] {
  const list = Array.isArray(info?.documents) ? info.documents : [];
  const docs: SessionDoc[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (!row) continue;
    docs.push({
      title: String(row.title ?? ""),
      path: String(row.path ?? ""),
      isLinked: row.isLinked === true,
      isFamily: row.isFamily === true || row.family === true,
      isWorkshared: row.isWorkshared === true || row.workshared === true,
      central: typeof row.central === "string" ? row.central : undefined,
    });
  }
  return docs;
}

/** The document list has no central. facts is an existing read, and only the models that might be the link are asked. */
async function withCentrals(docs: SessionDoc[], centralOf: (document: string) => Promise<string>): Promise<SessionDoc[]> {
  const out: SessionDoc[] = [];
  for (const doc of docs) {
    if (doc.isLinked || doc.isFamily || doc.central || doc.isWorkshared === false) { out.push(doc); continue; }
    const key = (doc.path || doc.title || "").trim();
    if (!key) { out.push(doc); continue; }
    try {
      out.push({ ...doc, central: await centralOf(key) });
    } catch {
      out.push(doc);
    }
  }
  return out;
}

export async function runReloadLink(args: { document: string; link_type_id: number | string; path?: string }, io?: ReloadIo) {
  const documentInfo = io?.documentInfo
    ?? ((document: string) => withRevitConnection((client) => client.sendCommand("fmc_document_info", { document })));
  const reload = io?.reload
    ?? ((params: { document: string; link_type_id: number; path?: string }) => withRevitConnection((client) => client.sendCommand("fmc_reload_link", params, 300000)));
  const centralOf = io?.centralOf
    ?? (async (document: string) => {
      const facts = asRecord(await withRevitConnection((client) => client.sendRaw("fmc_workshare_facts", { document })));
      return String(facts?.central ?? "");
    });
  let host: LinkHost | null = null;
  let open: SessionDoc[] = [];
  try {
    const info = asRecord(await documentInfo(args.document));
    host = (asRecord(info?.active) as LinkHost | null) ?? null;
    open = sessionDocs(info);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const plan = planReloadLink(args, null);
    const document = plan.ok ? { title: args.document, path: "" } : plan.document;
    return reply({ ok: false, refused: true, message: `Could not read the open document, so the link was not reloaded. ${message}`, document }, true);
  }
  const plan = planReloadLink(args, host);
  if (!plan.ok) return reply({ ok: false, refused: true, message: plan.message, document: plan.document }, true);
  try {
    const result = asRecord(await reload(plan.params)) ?? {};
    let session = open;
    let verdict = judgeReload(result, plan.params.path, session);
    if (!verdict.ok && plan.params.path && !verdict.hint) {
      session = await withCentrals(session, centralOf);
      verdict = judgeReload(result, plan.params.path, session);
    }
    const document = asRecord(result.document) ?? { title: host?.title ?? args.document, path: host?.path ?? "" };
    return reply({ ...result, ...verdict, document }, !verdict.ok);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, message, document: { title: host?.title ?? args.document, path: host?.path ?? "" } }, true);
  }
}

export function registerFmcReloadLinkTool(server: McpServer) {
  server.tool("fmc_reload_link", FMC_RELOAD_LINK_DESCRIPTION, shape, (args) => runReloadLink(args));
}
