import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { resolvedDocumentFrom, type ResolvedDocument } from "../fmc/docresolve.js";
import { runLinkPlan, type LinkIo, type LinkManageArgs } from "../fmc/linkmanage.js";
import type { SessionDoc } from "../fmc/reloadlink.js";
import { writeFileLog } from "../fmc/filelog.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  // F10: one shared writer (fmc/filelog.ts): adds the source column, reports a failed write
  writeFileLog(cfg, action, dryRun, target, result, detail);
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** The host model fmc_links just read or changed. A title-only model name still echoes resolved_document. */
export function linkResolvedDocument(facts: unknown, fallback?: unknown): ResolvedDocument | null {
  const row = facts && typeof facts === "object" ? facts as Record<string, unknown> : {};
  const fromFacts = resolvedDocumentFrom(row.resolved_document) ?? resolvedDocumentFrom(row.document) ?? resolvedDocumentFrom(fallback);
  if (fromFacts) return fromFacts;
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!model) return null;
  return { title: model.replace(/\.rvt$/i, ""), path: "" };
}

/** .rvt files in the folder and one level of subfolders (02_Shared\<Role>\). */
export function listModels(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = win.join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.toLowerCase().endsWith("_backup")) walk(full, depth + 1);
      else if (e.isFile() && /\.rvt$/i.test(e.name)) out.push(full);
    }
  };
  walk(folder, 0);
  return out;
}

export const FMC_LINKS_DESCRIPTION =
  "Formcraft links for every open project, not only the one on screen. Pass document as an exact title or a full path. " +
  "With several projects open, omitting document is FMC-DOC-REQUIRED. The active document is never a guess. " +
  "dry_run defaults to true. " +
  "Actions: audit (open document, or file for a closed .rvt via TransmissionData without opening it: name, path, load, pinned, workset, problems; " +
  "closed files leave pinned and workset null). link (shared coordinates; 02_Shared unless the source is open as a host). " +
  "pin. reload (one link_type_id; path is LoadFrom, omit path to Reload; fmc_reload_link is this reload with on_blocked fail). " +
  "repath (LoadFrom path onto link_type_id). unload (one link type, instances stay, no transaction). " +
  "apply (documents plus link_set of {path, role}; each host links the others, skips itself, workset Z_Links_<Role>, pinned, per-document results). " +
  "offline (TransmissionData on a closed file: edits of {id or from, to, load}). " +
  "on_blocked published_copy (default for link, reload, repath, apply) or fail. When the source is open as a host, published_copy does not link that file. " +
  "A workshared source is detach-saved to a new non-workshared read-only file under 01_WIP\\_LinkCopies (worksets discarded, not a central). " +
  "A non-workshared source is a file copy, then a Save As only if Revit still reports the same model. A byte copy keeps the central identity (SameCentralModelAsHost). " +
  "If the published file still returns LinkOpenAsHost, SameModelAsHost or SameCentralModelAsHost, the result is FMC-LINK-OPEN-AS-HOST and the hint names the blocking document. " +
  "Nothing is closed, saved, synced or activated. If the active document or view changes, the result is FMC-LINK-ACTIVE-CHANGED and it is not restored. " +
  "Other codes: FMC-DOC-NOT-FOUND, FMC-DOC-AMBIGUOUS, FMC-DOC-REQUIRED, FMC-LINK-PATH-MISMATCH, FMC-LINK-NOT-LOADED, FMC-LINK-PROTECTED, FMC-LINK-CENTRAL, FMC-LINK-OPEN-FILE, FMC-LINK-SAME-FILE. " +
  "Refuses writes to workshared centrals, a centrals folder, protected_paths, save_exclude (HEBERT HOSTELS covers HEBERT HOSTELS_USER) and 02_Shared / 03_Published. Reads of those paths are allowed. " +
  "Example: action apply, documents [A-0002_USER, S-0001, P-0001_USER, E-0001_USER], link_set [{path of A, role A}, {path of S, role S}, {path of P, role P}, {path of E, role E}], pin true, dry_run true, then the same call with dry_run false. " +
  "Server-side (hot swap): the plan, path guards and published-copy decision. Add-in DLL and a Revit restart: open-document audit, link, pin, reload, repath, unload, detach Save As, and TransmissionData read/write. " +
  "Coordinates are never moved.";

export const FMC_LINKS_SHAPE = {
  action: z.enum(["audit", "link", "pin", "reload", "repath", "unload", "apply", "offline"]),
  document: z.string().optional().default("").describe("Exact title or full path of one open host. Required when several projects are open."),
  documents: z.array(z.string()).optional().default([]).describe("apply: exact titles or full paths, one per host."),
  file: z.string().optional().default("").describe("audit or offline: a closed .rvt. Not opened. Ignored when it is already an open document (that document is audited instead)."),
  link_from: z.string().optional().default("").describe("audit: folder to list models from, normally <project>\\02_Shared"),
  models: z.array(z.string()).optional().default([]).describe("link: absolute paths of .rvt models in 02_Shared"),
  link_set: z.array(z.object({
    path: z.string(),
    role: z.string().optional(),
  })).optional().default([]).describe("apply: models to link into each host. role becomes workset Z_Links_<Role>. A container name or A-0002 supplies the role when role is omitted."),
  path: z.string().optional().default("").describe("reload/repath: .rvt to load. Omit on reload to reload the current path."),
  link_type_id: z.union([z.number().int(), z.string()]).optional().describe("reload, repath, unload: the Revit link type id (type_id from audit), not the instance id."),
  edits: z.array(z.object({
    id: z.number().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    load: z.boolean().optional(),
  })).optional().default([]).describe("offline: which closed-file link to repath or load. Match id or from."),
  copy_folder: z.string().optional().default("").describe("Folder for published link copies. Default is the host's 01_WIP\\_LinkCopies."),
  on_blocked: z.enum(["fail", "published_copy"]).optional().describe("fail returns FMC-LINK-OPEN-AS-HOST. published_copy (default for link, reload, repath, apply) links a copy that is not the open file."),
  pin: z.boolean().optional().default(true).describe("link and apply: pin after linking"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcLinksArgs = z.infer<z.ZodObject<typeof FMC_LINKS_SHAPE>>;

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function defaultLinkIo(): LinkIo {
  return {
    session: async () => {
      const info = recordOf(await withRevitConnection((client) => client.sendRaw("fmc_document_info", {}, 60000)));
      const documents: SessionDoc[] = [];
      for (const item of Array.isArray(info.documents) ? info.documents : []) {
        const row = recordOf(item);
        documents.push({
          title: String(row.title ?? ""),
          path: String(row.path ?? ""),
          isLinked: row.isLinked === true,
          isFamily: row.isFamily === true || row.family === true,
          family: row.family === true,
          isWorkshared: row.isWorkshared === true || row.workshared === true,
          central: typeof row.central === "string" ? row.central : undefined,
        });
      }
      return { documents };
    },
    facts: async (document) => recordOf(await withRevitConnection((client) => client.sendRaw("fmc_link_facts", { document }, 60000))),
    centralOf: async (document) => {
      const facts = recordOf(await withRevitConnection((client) => client.sendRaw("fmc_workshare_facts", { document }, 60000)));
      return String(facts.central ?? "");
    },
    transmissionRead: async (file) => recordOf(await withRevitConnection((client) => client.sendRaw("fmc_link_transmission", { document: file, file, write: false }, 60000))),
    transmissionWrite: async (params) => recordOf(await withRevitConnection((client) => client.sendRaw("fmc_link_transmission", { ...params, document: params.file, write: true }, 300000))),
    publish: async (params) => recordOf(await withRevitConnection((client) => client.sendCommand("fmc_link_publish", params, 300000))),
    linkAdd: async (params) => recordOf(await withRevitConnection((client) => client.sendCommand("fmc_link_add", params, 300000))),
    linkPin: async (params) => recordOf(await withRevitConnection((client) => client.sendCommand("fmc_link_pin", params, 60000))),
    reload: async (params) => recordOf(await withRevitConnection((client) => client.sendCommand("fmc_reload_link", params, 300000))),
    unload: async (params) => recordOf(await withRevitConnection((client) => client.sendCommand("fmc_link_unload", params, 300000))),
    copyFile: async (from, to) => {
      await fs.promises.mkdir(win.dirname(to), { recursive: true });
      try { if (fs.existsSync(to)) fs.chmodSync(to, 0o666); } catch { /* a new file has nothing to clear */ }
      await fs.promises.copyFile(from, to);
    },
    setReadOnly: async (file, on) => { fs.chmodSync(file, on ? 0o444 : 0o666); },
    removeFile: async (file) => { try { await fs.promises.unlink(file); } catch { /* already gone */ } },
    exists: (file) => { try { return fs.existsSync(file); } catch { return false; } },
    listModels,
  };
}

export async function runFmcLinks(args: FmcLinksArgs, io?: LinkIo) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    const planned = await runLinkPlan(args as LinkManageArgs, io ?? defaultLinkIo(), config);
    const target = String(args.document || args.file || (args.documents ?? [])[0] || "");
    const code = String(planned.body.code ?? (planned.body.ok === false ? "failed" : "done"));
    log(config, "links_" + args.action, dry, target, planned.isError ? code : "done", JSON.stringify(planned.body).slice(0, 500));
    return reply(planned.body, planned.isError);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "links_" + args.action, dry, "", "error", msg);
    return reply({ ok: false, error: msg, message: msg }, true);
  }
}

export function registerFmcLinksTool(server: McpServer) {
  server.tool("fmc_links", FMC_LINKS_DESCRIPTION, FMC_LINKS_SHAPE, (args) => runFmcLinks(args));
}
