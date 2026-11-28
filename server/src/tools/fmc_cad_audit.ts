import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { errorCode, gapReply } from "../fmc/gapcommon.js";
import { auditCad, type CadRead } from "../fmc/cadaudit.js";

export const FMC_CAD_AUDIT_DESCRIPTION =
  "GAP-14. Read-only CAD and image audit: imported versus linked CAD (2D in one view, or 3D in model space), link status and path, " +
  "CAD import line styles with no CAD left, CAD inside loadable families (each family is opened in memory and closed without saving), " +
  "and raster images (imported or linked, placed or unused, missing file). Returns a prioritised clean-up plan as text. " +
  "Nothing is deleted or changed: deletes go through fmc_wipe with the person's approval. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, scan_families true.";

export const FMC_CAD_AUDIT_SHAPE = {
  document: z.string().optional().default(""),
  scan_families: z.boolean().optional().default(true).describe("Open each editable loadable family in memory to count CAD inside it. Slower on big models."),
  max_families: z.number().int().min(0).max(2000).optional().default(300),
};

export type FmcCadAuditArgs = z.infer<z.ZodObject<typeof FMC_CAD_AUDIT_SHAPE>>;

export interface CadAuditIo { read?: (body: Record<string, unknown>) => Promise<unknown> }

export async function runFmcCadAudit(args: FmcCadAuditArgs, io: CadAuditIo = {}) {
  const stamp = { tool: "fmc_cad_audit", read_only: true, saved: false, synced: false, deleted: 0 };
  try {
    if (!args.document.trim()) return gapReply({ ...stamp, refused: true, code: "FMC-DOC-REQUIRED", message: "fmc_cad_audit needs document, a title or a full path. The active document is not a guess." }, true);
    const body = { document: args.document.trim(), scan_families: args.scan_families !== false, max_families: args.max_families };
    const raw = io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_cad_audit", body, 900000));
    const read = (raw && typeof raw === "object" ? raw : {}) as CadRead;
    const audit = auditCad({ ...read, imports: read.imports ?? [], import_categories: read.import_categories ?? [], families: read.families ?? [], images: read.images ?? [] });
    return gapReply({
      ...stamp, document: read.title ?? args.document, status: audit.status, counts: audit.counts, plan: audit.plan,
      imports: read.imports ?? [], families_with_cad: (read.families ?? []).filter((f) => f.imports + f.linked > 0), images: read.images ?? [],
      note: "The plan is text. Nothing was deleted. Deletes go through fmc_wipe with the person's approval.",
    });
  } catch (error) {
    return gapReply({ ...stamp, refused: true, ...errorCode(error, "FMC-CAD-AUDIT") }, true);
  }
}

export function registerFmcCadAuditTool(server: McpServer) {
  server.tool("fmc_cad_audit", FMC_CAD_AUDIT_DESCRIPTION, FMC_CAD_AUDIT_SHAPE, async (args) => runFmcCadAudit(args as FmcCadAuditArgs));
}
