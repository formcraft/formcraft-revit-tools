import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { judgePositions, judgeReload, mayBeTheLink, planReloadLink, type LinkHost, type SessionDoc } from "../fmc/reloadlink.js";

export const FMC_RELOAD_LINK_DESCRIPTION =
  "Reloads one Revit link type in a named open project. Pass document (a title or a full path) and link_type_id. " +
  "Pass path to load that file (LoadFrom); omit path to reload the link from where it is (Reload). " +
  "Link instances stay where they are. This is a write: it needs the batch lease, and the live-model lock applies. " +
  "A family, a verification copy, a linked document and a protected original are refused. " +
  "Needs the add-in: the reload runs in its own handler, which opens no transaction. " +
  "send_code_to_revit cannot do this: even transactionMode none still opens a transaction group, and Revit 2025 refuses the reload while that phase is open. " +
  "A reply is success only when the link document is open and, if a path was given, that path is the one Revit has. " +
  "status Loaded is not enough. LinkOpenAsHost is FMC-LINK-OPEN-AS-HOST. A path that did not change is FMC-LINK-PATH-MISMATCH. " +
  "A null link document, or any other status, is FMC-LINK-NOT-LOADED. The hint names the open document that blocks the load. " +
  "dry_run defaults to true: it reads the link (status, path, instances) and the open documents that could block it, and changes nothing; the reload needs dry_run false. " +
  "worksets keep (default: the link's open worksets stay open), last_viewed or all. A reload that moved or dropped a link instance is FMC-LINK-MOVED. " +
  "If the 300 s wait runs out, the reply reads the link again and says its state (timed_out true). " +
  "This is the strict reload (on_blocked fail). For a published-copy route that does not close the blocking document, use fmc_links action reload or apply with on_blocked published_copy.";

const shape = {
  document: z.string().min(1).describe("Title or full path of the open project that holds the link. A family is refused."),
  link_type_id: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).describe("Element id of the Revit link type, not of a link instance."),
  path: z.string().optional().describe("Full path to load the link from. Omit to reload the link from its current path."),
  dry_run: z.boolean().optional().default(true).describe("true (default): the plan and blockers only; false reloads"),
  worksets: z.enum(["keep", "last_viewed", "all"]).optional().default("keep").describe("Which link worksets are open after the reload"),
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
  /** Read-only link facts (fmc_link_facts): the dry run and the state after a timeout. */
  linkFacts?(document: string): Promise<unknown>;
}

/** The link rows of one link type from fmc_link_facts. */
function linkRowsOf(facts: unknown, typeId: number): Array<Record<string, unknown>> {
  const body = asRecord(facts);
  const rows = Array.isArray(body?.links) ? body!.links as unknown[] : Array.isArray(body?.instances) ? body!.instances as unknown[] : [];
  return rows.map(asRecord).filter((row): row is Record<string, unknown> => !!row && Number(row.type_id) === typeId);
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
async function withCentrals(docs: SessionDoc[], centralOf: (document: string) => Promise<string>, linkPath = ""): Promise<SessionDoc[]> {
  const out: SessionDoc[] = [];
  for (const doc of docs) {
    if (doc.isLinked || doc.isFamily || doc.central || doc.isWorkshared === false || (linkPath && !mayBeTheLink(doc, linkPath))) { out.push(doc); continue; }
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

export async function runReloadLink(args: { document: string; link_type_id: number | string; path?: string; dry_run?: boolean; worksets?: "keep" | "last_viewed" | "all" }, io?: ReloadIo) {
  const documentInfo = io?.documentInfo
    ?? ((document: string) => withRevitConnection((client) => client.sendCommand("fmc_document_info", { document })));
  const reload = io?.reload
    ?? ((params: { document: string; link_type_id: number; path?: string }) => withRevitConnection((client) => client.sendCommand("fmc_reload_link", params, 300000)));
  const linkFacts = io?.linkFacts
    ?? ((document: string) => withRevitConnection((client) => client.sendRaw("fmc_link_facts", { document }, 60000)));
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
  const hostDoc = { title: host?.title ?? args.document, path: host?.path ?? "" };
  const worksets = args.worksets ?? "keep";
  // RL-1: a dry run reads the link and names what could block it. Nothing is reloaded.
  if (args.dry_run !== false) {
    let rows: Array<Record<string, unknown>> = [];
    let factsError = "";
    try { rows = linkRowsOf(await linkFacts(plan.params.document), plan.params.link_type_id); } catch (error) { factsError = error instanceof Error ? error.message : String(error); }
    const target = plan.params.path || String(rows[0]?.path ?? "");
    const blockers = open.filter((doc) => !doc.isLinked && !doc.isFamily && target && mayBeTheLink(doc, target)
      && (doc.title ?? "").toLowerCase() !== (host?.title ?? "").toLowerCase()).map((doc) => doc.title || doc.path || "");
    return reply({
      ok: true, dry_run: true, read_only: true, would_reload: true,
      method: plan.params.path ? "LoadFrom" : "Reload", link_type_id: plan.params.link_type_id, path: target || null,
      current: rows.length ? { status: rows[0].status ?? null, path: rows[0].path ?? null, instances: rows.length } : null,
      ...(factsError ? { facts_error: factsError } : {}),
      worksets, may_block: blockers, document: hostDoc,
      next: blockers.length ? `Close or unload ${blockers.join(", ")} first, or the load can fail as open-as-host. Then dry_run false.` : "Reload with dry_run false (batch lease needed).",
    });
  }
  try {
    const result = asRecord(await reload({ ...plan.params, worksets } as typeof plan.params)) ?? {};
    let session = open;
    let verdict = judgeReload(result, plan.params.path, session);
    if (!verdict.ok && plan.params.path && !verdict.hint) {
      session = await withCentrals(session, centralOf, plan.params.path);
      verdict = judgeReload(result, plan.params.path, session);
    }
    verdict = judgePositions(result, verdict);
    const document = asRecord(result.document) ?? hostDoc;
    return reply({ ...result, ...verdict, document }, !verdict.ok);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // RL-5: after a timeout the link may still have loaded. Read it once and say what it is.
    if (/timed out|timeout/i.test(message)) {
      let state: Record<string, unknown> | null = null;
      try {
        const rows = linkRowsOf(await linkFacts(plan.params.document), plan.params.link_type_id);
        state = rows.length ? { status: rows[0].status ?? null, path: rows[0].path ?? null, instances: rows.length } : { status: "not found" };
      } catch (readError) { state = { status: "unknown", detail: readError instanceof Error ? readError.message : String(readError) }; }
      return reply({ ok: false, timed_out: true, code: "FMC-LINK-TIMEOUT", message: `${message}. The link is now ${String(state?.status ?? "unknown")}${state?.path ? ` at ${String(state.path)}` : ""}.`, link_state: state, document: hostDoc }, true);
    }
    return reply({ ok: false, message, document: hostDoc }, true);
  }
}

export function registerFmcReloadLinkTool(server: McpServer) {
  server.tool("fmc_reload_link", FMC_RELOAD_LINK_DESCRIPTION, shape, (args) => runReloadLink(args));
}
