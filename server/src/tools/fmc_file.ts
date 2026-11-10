import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
  DocInfo, GuardConfig, archivePlan, checkTemplatePath, checkWritePath, csvLine, expandEnv, loadConfig,
} from "../fmc/policy.js";
import { planOpenCopy, protectedRoots } from "../fmc/opencopy.js";

const win = path.win32;
const EXT_FOR_KIND: Record<string, string> = { project: ".rvt", template: ".rte", family: ".rfa" };
const TEMPLATE_EXT_FOR_KIND: Record<string, string> = { project: ".rte", template: ".rte", family: ".rft" };

function same(a: string, b: string) {
  return win.normalize(a).toLowerCase() === win.normalize(b).toLowerCase();
}

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work; the tool result still reports what happened
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

async function documents(): Promise<{ active: DocInfo | null; documents: DocInfo[] }> {
  return withRevitConnection((c) => c.sendRaw("fmc_document_info", {}));
}

export const FMC_FILE_DESCRIPTION =
  "Formcraft file operations in Revit with guard rails: list open documents, create a new family, template or model " +
    "from a template, save as, close, and archive (move to _Archive; nothing is ever deleted). Writes go only to the " +
    "folders in fmc_guard.json (WIP and staging), never to 02_Shared, 03_Published or 04_Families\\<Role>. Every " +
    "write is a dry run unless dry_run is false; overwrite and archive also need confirm=true. Show the user the dry-run " +
    "result before running it for real. " +
    "open_copy reads a closed .rvt and opens a different copy in the background, detached when the file is workshared, " +
    "never as the active document, never saved, synced or relinquished. links.mode is keep (load the link read-only), " +
    "unload, or repath [{from, to}]. Transmission data is written only on the copy. A path under protected_roots or " +
    "live_paths is refused as the copy. close_copy closes that document without saving. " +
    "Example: {\"action\":\"open_copy\",\"source\":\"D:\\\\Fomcraft\\\\proj\\\\01_WIP\\\\S\\\\model.rvt\"," +
    "\"copy_to\":\"C:\\\\Users\\\\USER\\\\agent-tools\\\\ogala-R04\\\\model.copy.rvt\"," +
    "\"links\":{\"mode\":\"keep\"},\"protected_roots\":[\"D:\\\\Fomcraft\"],\"dry_run\":true}.";

/** Arguments of the fmc_file tool. The Formcraft Browser's CLI (fmc/cli.ts) parses with the same schema, so defaults match. */
export const FMC_FILE_SHAPE = {
  action: z.enum(["list_open", "create_from_template", "save_as", "close", "archive", "open_copy", "close_copy"]),
  kind: z.enum(["project", "template", "family"]).optional().describe("create_from_template: what to create"),
  template_path: z.string().optional().describe("create_from_template: absolute path of the .rft or .rte"),
  save_path: z.string().optional().describe("create_from_template, save_as: absolute target path"),
  document: z.string().optional().describe("save_as, close: document title or full path (from list_open)"),
  path: z.string().optional().describe("archive: absolute path of a closed file to move to _Archive"),
  source: z.string().optional().describe("open_copy: the closed .rvt to read. Never written."),
  copy_to: z.string().optional().describe("open_copy: the copy path. Must differ from source and must not be a protected or live path."),
  links: z.object({
    mode: z.enum(["keep", "unload", "repath"]).describe("keep loads links read-only; unload loads none; repath points named links at new paths"),
    repath: z.array(z.object({
      from: z.string(),
      to: z.string(),
      load: z.boolean().optional().describe("Load the repathed link. Default true. The link file is not saved."),
    })).optional(),
  }).optional().describe("open_copy: what to do with Revit links on the copy before it opens. Default unload."),
  detach: z.enum(["preserve", "discard"]).optional().default("preserve").describe("open_copy, workshared files: DetachAndPreserveWorksets or DetachAndDiscardWorksets. Non-workshared files are not detached."),
  audit: z.boolean().optional().default(false).describe("open_copy: Revit OpenOptions.Audit"),
  worksets: z.union([z.enum(["all", "last", "none"]), z.array(z.string())]).optional().describe("open_copy: worksets to open. Default all. An array is those user workset names."),
  protected_roots: z.array(z.string()).optional().describe("Original folders that must not be written, saved, synced or opened as the copy. Added to the guard; never removed."),
  copy_roots: z.array(z.string()).optional().describe("open_copy: extra folders the copy may be written to, with the guard's copy_roots"),
  live_paths: z.array(z.string()).optional().describe("Full paths of the live originals. Refused as copy_to."),
  overwrite: z.boolean().optional().default(false).describe("Replace an existing file (needs confirm=true)"),
  save: z.boolean().optional().default(false).describe("close: save before closing"),
  close_after: z.boolean().optional().default(true).describe("create_from_template: close the new file after saving"),
  project_info: z.record(z.string(), z.string()).optional().describe("create_from_template (project): Project Information to fill in before saving"),
  dry_run: z.boolean().optional().default(true).describe("Report what would happen without doing it"),
  confirm: z.boolean().optional().default(false).describe("Required for overwrite and archive"),
};

export type FmcFileArgs = z.infer<z.ZodObject<typeof FMC_FILE_SHAPE>>;

/** The whole tool: checks, dry run, Revit call and log row. Claude and the Formcraft Browser both run this. */
export async function runFmcFile(args: FmcFileArgs) {
  const { config, problem } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    if (args.action === "list_open") {
      return reply({ config_problem: problem, ...(await documents()) });
    }

    if (args.action === "open_copy") {
      const plan = planOpenCopy({
        source: args.source ?? "", copyTo: args.copy_to ?? "", links: args.links, detach: args.detach, audit: args.audit,
        worksets: args.worksets, protectedRoots: args.protected_roots, copyRoots: args.copy_roots, livePaths: args.live_paths,
        overwrite: args.overwrite,
      }, config, fs.existsSync);
      if (!plan.ok) {
        log(config, "open_copy", dry, plan.copy_to || plan.source, "refused", plan.reasons.join(" | "));
        return reply({ refused: true, reasons: plan.reasons, plan, config_problem: problem }, true);
      }
      if (dry) return reply({ dry_run: true, would_do: plan, next: "Run again with dry_run=false. The source file is not modified." });
      let open: { documents?: DocInfo[] } = { documents: [] };
      try { open = await documents(); } catch { /* Revit answers the open call itself */ }
      const already = (open.documents ?? []).find((d) => d.path && same(d.path, plan.copy_to));
      let created = false;
      if (!already) {
        created = !fs.existsSync(plan.copy_to);
        fs.mkdirSync(win.dirname(plan.copy_to), { recursive: true });
        fs.copyFileSync(plan.source, plan.copy_to);
      }
      try {
        const result = await withRevitConnection((c) => c.sendRaw("fmc_open_copy", {
          source: plan.source, copy_to: plan.copy_to, links: plan.links, detach: plan.detach, audit: plan.audit,
          worksets: plan.worksets, _protected_roots: protectedRoots(config, args.protected_roots),
          live_paths: args.live_paths ?? [], created_copy: created, already_open: !!already,
        }, 300000));
        log(config, "open_copy", false, plan.copy_to, "done", JSON.stringify(result));
        return reply({ done: true, writes_source: false, saved: false, synced: false, relinquished: false, result });
      } catch (error) {
        if (created) { try { fs.unlinkSync(plan.copy_to); } catch { /* the copy may be locked by the failed open */ } }
        throw error;
      }
    }

    if (args.action === "close_copy") {
      if (!args.document) return reply({ refused: true, reasons: ["document is required (the copy's title or path)"] }, true);
      const plan = { action: "close_copy", document: args.document, save: false };
      if (dry) return reply({ dry_run: true, would_do: plan, next: "Run again with dry_run=false. The copy is closed without saving." });
      const result = await withRevitConnection((c) => c.sendRaw("fmc_close_document", { document: args.document, save: false, verification_copy: true }));
      log(config, "close_copy", false, args.document, "done", JSON.stringify(result));
      return reply({ done: true, saved: false, result });
    }

    if (args.action === "create_from_template" || args.action === "save_as") {
      const reasons: string[] = [];
      const target = args.save_path ?? "";
      if (!target) reasons.push("save_path is required");
      if (args.action === "create_from_template") {
        const kind = args.kind ?? "";
        if (!kind) reasons.push("kind is required");
        if (!args.template_path) reasons.push("template_path is required");
        else {
          reasons.push(...checkTemplatePath(args.template_path, config).reasons);
          if (kind && win.extname(args.template_path).toLowerCase() !== TEMPLATE_EXT_FOR_KIND[kind])
            reasons.push(`A ${kind} is created from a ${TEMPLATE_EXT_FOR_KIND[kind]} template`);
          if (!fs.existsSync(args.template_path)) reasons.push(`Template not found: ${args.template_path}`);
        }
        if (kind && target && win.extname(target).toLowerCase() !== EXT_FOR_KIND[kind])
          reasons.push(`A ${kind} is saved as ${EXT_FOR_KIND[kind]}`);
      } else if (!args.document) reasons.push("document is required");
      if (target) {
        reasons.push(...checkWritePath(target, config).reasons);
        if (fs.existsSync(target) && !args.overwrite) reasons.push(`${target} exists; set overwrite=true and confirm=true to replace it`);
        if (args.overwrite && !args.confirm) reasons.push("overwrite needs confirm=true");
      }
      const plan = { action: args.action, kind: args.kind, template_path: args.template_path, document: args.document,
        save_path: target, overwrite: args.overwrite, close_after: args.close_after, max_backups: config.max_backups,
        project_info: args.action === "create_from_template" ? args.project_info : undefined };
      if (reasons.length) {
        log(config, args.action, dry, target, "refused", reasons.join(" | "));
        return reply({ refused: true, reasons, config_problem: problem, plan }, true);
      }
      if (dry) return reply({ dry_run: true, would_do: plan, next: "Run again with dry_run=false" });
      const result = await withRevitConnection((c) =>
        args.action === "create_from_template"
          ? c.sendRaw("fmc_create_document", plan)
          : c.sendRaw("fmc_save_document_as", plan));
      log(config, args.action, false, target, "done", JSON.stringify(result));
      return reply({ done: true, result });
    }

    if (args.action === "close") {
      if (!args.document) return reply({ refused: true, reasons: ["document is required"] }, true);
      if (args.save) {
        const info = await documents();
        const doc = info.documents.find((d) => d.title === args.document || (d.path && same(d.path, args.document!)));
        if (!doc) return reply({ refused: true, reasons: [`Not open: ${args.document}`] }, true);
        const v = doc.path ? checkWritePath(doc.path, config) : { ok: false, reasons: ["Never saved: use save_as first"] };
        if (!v.ok) {
          log(config, "close+save", dry, doc.path, "refused", v.reasons.join(" | "));
          return reply({ refused: true, reasons: v.reasons }, true);
        }
      }
      const plan = { document: args.document, save: args.save };
      if (dry) return reply({ dry_run: true, would_do: { action: "close", ...plan }, next: "Run again with dry_run=false" });
      const result = await withRevitConnection((c) => c.sendRaw("fmc_close_document", plan));
      log(config, "close", false, args.document, "done", JSON.stringify(result));
      return reply({ done: true, result });
    }

    // archive: move a closed file and its backups to _Archive; never delete
    const target = args.path ?? "";
    const reasons: string[] = [];
    if (!target) reasons.push("path is required");
    else {
      reasons.push(...checkWritePath(target, config, { checkName: false }).reasons);
      if (!fs.existsSync(target)) reasons.push(`Not found: ${target}`);
      const info = await documents();
      if (info.documents.some((d) => d.path && same(d.path, target))) reasons.push(`${target} is open in Revit; close it first`);
    }
    if (!dry && !args.confirm) reasons.push("archive needs confirm=true");
    if (reasons.length) {
      log(config, "archive", dry, target, "refused", reasons.join(" | "));
      return reply({ refused: true, reasons, config_problem: problem }, true);
    }
    const plan = archivePlan(target, fs.readdirSync(win.dirname(target)));
    if (dry) return reply({ dry_run: true, would_move: plan.moves, next: "Run again with dry_run=false and confirm=true" });
    fs.mkdirSync(win.dirname(plan.moves[0][1]), { recursive: true });
    for (const [from, to] of plan.moves) fs.renameSync(from, to);
    log(config, "archive", false, target, "done", plan.moves.map((m) => m[1]).join(" | "));
    return reply({ done: true, moved: plan.moves });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, args.action, dry, args.save_path ?? args.path ?? args.document ?? "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcFileTool(server: McpServer) {
  server.tool("fmc_file", FMC_FILE_DESCRIPTION, FMC_FILE_SHAPE, (args) => runFmcFile(args));
}
