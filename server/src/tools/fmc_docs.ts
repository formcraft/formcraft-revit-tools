import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { loadConfig, type GuardConfig } from "../fmc/policy.js";
import { documentsFolder, filterDocs, planClose, planOpen, type OpenDocRow } from "../fmc/docsplan.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_DOCS_DESCRIPTION =
  "Open and close Revit documents. list: the open documents, including family documents; document narrows it to one title, path or file name, " +
    "and family, modified or workshared (true or false) filter it; total is the count before filtering. " +
  "open {path, as_local default true for a workshared central, detach, worksets all or last}: a workshared central becomes a new local in Documents. " +
  "detach opens a detached copy and does not write the central. " +
  "close {document, save default false}: a dirty document is refused unless save is true. The last open document is never closed. " +
  "A save is refused under protected_roots, for a title in save_exclude, and for a protected project name (HEBERT HOSTELS, plus the guard's never_write_titles). A workshared model is not saved. " +
  "dry_run defaults to true. open and close with dry_run false need batch_lease. Revit API calls stay on the API thread. " +
  "Example: {\"action\":\"open\",\"path\":\"D:\\\\Models\\\\Central.rvt\",\"dry_run\":true}.";

const shape = {
  action: z.enum(["list", "open", "close"]),
  path: z.string().optional().default("").describe("open: the .rvt or .rfa to open"),
  document: z.string().optional().default("").describe("close: title or full path of an open document. list: only that document"),
  family: z.boolean().optional().describe("list: only family documents (true) or only project documents (false)"),
  modified: z.boolean().optional().describe("list: only modified (true) or unmodified (false) documents"),
  as_local: z.boolean().optional().describe("open: default true for a workshared central. A new local is created in Documents."),
  detach: z.boolean().optional().default(false).describe("open: detach from central. The central is not written."),
  worksets: z.enum(["all", "last"]).optional().default("all"),
  workshared: z.boolean().optional().describe("open: set when the path is a workshared file and Revit has not been asked yet. list: only workshared (true) or non-workshared (false) documents"),
  central: z.boolean().optional().describe("open: the path is the central model"),
  save: z.boolean().optional().default(false).describe("close: false by default. true saves a non-workshared document that is not protected."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
};

export type FmcDocsArgs = z.infer<z.ZodObject<typeof shape>>;

export interface DocsIo {
  list?: () => Promise<OpenDocRow[]>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
}

async function listed(io: DocsIo): Promise<OpenDocRow[]> {
  if (io.list) return io.list();
  const body = await withRevitConnection((client) => client.sendRaw("fmc_docs", { action: "list" }, 60000)) as { documents?: OpenDocRow[] };
  return body?.documents ?? [];
}

function leaseOf(args: FmcDocsArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

export async function runFmcDocs(args: FmcDocsArgs, io: DocsIo = {}) {
  const guard = io.guard ?? loadConfig().config;
  const env = io.env ?? process.env;
  try {
    if (args.action === "list") {
      const all = await listed(io);
      const filter = { document: args.document, family: args.family, modified: args.modified, workshared: args.workshared };
      const documents = filterDocs(all, filter);
      const filtered = !!args.document.trim() || args.family != null || args.modified != null || args.workshared != null;
      if (args.document.trim() && !documents.length) {
        return reply({ tool: "fmc_docs", action: "list", read_only: true, refused: true, code: "FMC-DOC-NOT-OPEN", count: 0, total: all.length, documents: [],
          message: `No open document matches ${args.document.trim()}. Open: ${all.map((d) => d.title).join(", ") || "none"}.` }, true);
      }
      return reply({ tool: "fmc_docs", action: "list", read_only: true, count: documents.length, total: all.length, ...(filtered ? { filtered: true } : {}), documents });
    }
    if (args.action === "open") {
      let workshared = args.workshared;
      let central = args.central;
      if (workshared == null || central == null) {
        try {
          const probe = io.apply
            ? await io.apply({ action: "probe", path: args.path }) as { workshared?: boolean; central?: boolean }
            : await withRevitConnection((client) => client.sendRaw("fmc_docs", { action: "probe", path: args.path }, 60000)) as { workshared?: boolean; central?: boolean };
          if (workshared == null) workshared = probe?.workshared === true;
          if (central == null) central = probe?.central === true;
        } catch {
          workshared = workshared === true;
          central = central === true;
        }
      }
      const plan = planOpen({
        path: args.path, as_local: args.as_local, detach: args.detach, worksets: args.worksets,
        workshared, central, documents: documentsFolder(env),
      });
      if (!plan.ok) return reply({ tool: "fmc_docs", refused: true, reasons: plan.reasons, dry_run: true }, true);
      if (args.dry_run !== false) return reply({ tool: "fmc_docs", action: "open", ...plan, read_only: true, next: "Open with dry_run false and batch_lease." });
      const lease = leaseOf(args);
      if (!lease) return reply({ tool: "fmc_docs", refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was opened." }, true);
      const applied = io.apply
        ? await io.apply({ action: "open", ...plan, batch_lease: lease })
        : await withRevitConnection((client) => client.sendCommand("fmc_docs_apply", { action: "open", path: plan.path, as_local: plan.as_local, detach: plan.detach, worksets: plan.worksets, local_path: plan.local_path }, 300000));
      return reply({ tool: "fmc_docs", action: "open", ...plan, dry_run: false, result: applied });
    }
    const open = await listed(io);
    const plan = planClose({ document: args.document, save: args.save, open, guard });
    if (!plan.ok) return reply({ tool: "fmc_docs", action: "close", refused: true, ...plan }, true);
    if (args.dry_run !== false) return reply({ tool: "fmc_docs", action: "close", ...plan, read_only: true, next: "Close with dry_run false and batch_lease." });
    const lease = leaseOf(args);
    if (!lease) return reply({ tool: "fmc_docs", refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was closed." }, true);
    const applied = io.apply
      ? await io.apply({ action: "close", document: plan.document, save: plan.save, path: plan.path })
      : await withRevitConnection((client) => client.sendCommand("fmc_docs_apply", { action: "close", document: plan.path || plan.document, save: plan.save }, 120000));
    return reply({ tool: "fmc_docs", action: "close", ...plan, dry_run: false, result: applied });
  } catch (error) {
    return reply({ tool: "fmc_docs", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcDocsTool(server: McpServer) {
  server.tool("fmc_docs", FMC_DOCS_DESCRIPTION, shape, (args) => runFmcDocs(args));
}
