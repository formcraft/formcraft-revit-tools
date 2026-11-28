import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, loadConfig } from "../fmc/policy.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { FabRead, ancillarySummary, auditParts, cleanPart, configReport, filterByLevel } from "../fmc/fabrication.js";
import { OutFormat, checkOutputFolder, csvText, jsonText, localDir, log, newRunId, wantedFiles, writeReports } from "../fmc/fabrication_out.js";

export const FMC_FABRICATION_DESCRIPTION =
  "Formcraft MEP fabrication support. Read only: the Revit side only reads, there is no transaction and no model change. " +
    "config: is a FabricationConfiguration loaded in the model? Its name, version and path, the FabricationService list, and which " +
    "services are loaded and which are not. If no configuration is loaded the answer is ok:true, configured:false and a message, " +
    "never an error. audit: the FabricationParts counted by service, category and level, plus the parts with no service, a service " +
    "that isn't in the configuration or isn't loaded, no specification, no material, no insulation (only when require_insulation " +
    "is set), disconnected ends, an invalid validation status, or an iso drawing out of date (NeedToUpdateIsoDrawing; the API " +
    "doesn't compare a part with its catalogue item), each with sample ids. ancillaries: per part, the ancillaries it uses " +
    "(hangers, stiffeners, seams, connectors ...) with quantities, and the totals by usage, type and name. export: the " +
    "audit, the ancillaries and one row per part as CSV and/or JSON. By default the files go to the tool's own folder " +
    "(FMC_FABRICATION_DIR, else %LOCALAPPDATA%\\Formcraft\\fabrication). output_path is a project folder instead: it must be inside " +
    "the write roots, it is a dry run until dry_run=false with confirm=true, it is logged, and a Revit file is never written. " +
    "levels limits every action to those level names. Every reply carries a run_id (also in the file log).";

export const FMC_FABRICATION_SHAPE = {
  action: z.enum(["config", "audit", "ancillaries", "export"]),
  document: z.string().optional().default("").describe("Title or full path of an open document. Several open: name it."),
  levels: z.array(z.string()).optional().default([]).describe("Level names. Empty covers every level."),
  require_insulation: z.boolean().optional().default(false).describe("audit, export: count a part with no insulation specification as a problem (off: it is only reported)"),
  sample_limit: z.number().int().min(1).max(500).optional().default(25).describe("Sample ids per problem and rows in the per-part ancillary list"),
  format: z.enum(["csv", "json", "both"]).optional().default("both").describe("export: which report files"),
  output_path: z.string().optional().default("").describe("export: a project folder to write the report into (write roots only). Empty: the tool's own folder."),
  dry_run: z.boolean().optional().default(true).describe("export with output_path: true shows what would be written and writes nothing"),
  confirm: z.boolean().optional().default(false).describe("export with output_path: required with dry_run=false, after the person has seen the dry run"),
};
export type FmcFabricationArgs = z.infer<z.ZodObject<typeof FMC_FABRICATION_SHAPE>>;

export interface FabricationIo {
  /** The add-in read; tests give a stand-in. */
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  config?: { config: GuardConfig; problem: string };
  env?: NodeJS.ProcessEnv;
  dir?: string;
}

type Reply = { content: Array<{ type: "text"; text: string }>; isError: boolean };

export async function runFmcFabrication(args: FmcFabricationArgs, io: FabricationIo = {}): Promise<Reply> {
  const run_id = newRunId();
  const env = io.env ?? process.env;
  const { config, problem } = io.config ?? loadConfig();
  const reply = (body: object, isError = false): Reply => ({
    content: [{ type: "text", text: JSON.stringify({ tool: "fmc_fabrication", run_id, read_only: true, transaction: false, model_changed: false, ...body }, null, 2) }], isError,
  });
  const dry = args.dry_run !== false;
  try {
    const wantParts = args.action !== "config";
    const body = { document: args.document, parts: wantParts, ancillaries: args.action === "ancillaries" || args.action === "export" };
    const raw = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_fabrication", body, 300000))) as Record<string, unknown>;
    if (raw && (raw.refused || raw.code)) return reply({ ok: false, refused: true, code: raw.code || "FMC-FABRICATION", message: raw.message || "The read was refused." }, true);
    const read: FabRead = {
      ...(raw as unknown as FabRead),
      configured: (raw as { configured?: unknown }).configured === true,
      parts: Array.isArray(raw?.parts) ? (raw.parts as unknown[]).map(cleanPart) : undefined,
    };
    const document = read.resolved_document?.title || args.document;
    const notes = read.notes ?? [];
    if (!read.configured) {
      const c = configReport(read);
      return reply({ ok: true, configured: false, message: c.message, document, fabrication_parts_in_model: c.fabrication_parts_in_model, notes, exported: false,
        next: "Load a fabrication configuration in Revit (Manage › Fabrication), then run this again. Nothing was written." });
    }
    const opts = { require_insulation: args.require_insulation, sample_limit: args.sample_limit };
    const parts = filterByLevel(read.parts ?? [], args.levels);
    const common = { ok: true, configured: true, document, levels: args.levels, parts_total: read.parts_total ?? parts.length, parts_read: (read.parts ?? []).length,
      truncated: read.parts_truncated === true, notes };
    if (args.action === "config") return reply({ ...common, ...configReport(read) });
    if (args.action === "audit") return reply({ ...common, audit: auditParts(parts, read.services, opts) });
    if (args.action === "ancillaries") return reply({ ...common, ancillaries: ancillarySummary(parts, args.sample_limit) });

    // export
    const format = args.format as OutFormat;
    const files = wantedFiles(format, run_id);
    const texts = { csv: csvText(parts, read.services, args.require_insulation), json: jsonText(read, parts, { ...opts, run_id, document }) };
    const summary = { ...common, parts_exported: parts.length, audit: { parts_with_issues: auditParts(parts, read.services, opts).parts_with_issues } };
    if (!args.output_path.trim()) {
      const folder = io.dir ?? localDir(env);
      const written = writeReports(folder, files, texts);
      log(config, false, folder, "done", `${parts.length} part(s): ${files.map((f) => f.name).join(", ")}`, "fabrication_export", run_id);
      return reply({ ...summary, exported: true, destination: "tool folder", folder, files: written });
    }
    const target = checkOutputFolder(args.output_path, config, run_id, format);
    const reasons = [...target.reasons];
    if (problem && !dry) reasons.push(problem);
    if (!dry && !args.confirm) reasons.push("dry_run=false writes the report files into the project folder: show the person the dry run first, then call again with confirm=true");
    if (reasons.length) {
      log(config, dry, args.output_path, "refused", reasons.join(" | "), "fabrication_export", run_id);
      return reply({ ok: false, refused: true, reasons }, true);
    }
    const plan = files.map((f) => path.join(target.folder, f.name));
    if (dry) {
      log(config, true, target.folder, "dry run", `${parts.length} part(s): ${files.map((f) => f.name).join(", ")}`, "fabrication_export", run_id);
      return reply({ ...summary, exported: false, dry_run: true, folder: target.folder, would_write: plan, next: "Show the person; then dry_run=false with confirm=true writes these two report files (never a Revit file)" });
    }
    const written = writeReports(target.folder, files, texts);
    log(config, false, target.folder, "done", `${parts.length} part(s): ${files.map((f) => f.name).join(", ")}`, "fabrication_export", run_id);
    return reply({ ...summary, exported: true, dry_run: false, destination: "project folder", folder: target.folder, files: written });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-FABRICATION";
    if (args.action === "export") log(config, dry, args.output_path || "tool folder", "error", message, "fabrication_export", run_id);
    return reply({ ok: false, refused: true, code, message }, true);
  }
}

export function registerFmcFabricationTool(server: McpServer) {
  server.tool("fmc_fabrication", FMC_FABRICATION_DESCRIPTION, FMC_FABRICATION_SHAPE, async (args) => runFmcFabrication(args as FmcFabricationArgs));
}
