import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { EXCLUDED_DOMAINS_NOTE, MEP_AUDIT_SCHEMA, shapeMepAudit, type MepAuditSnapshot } from "../fmc/mepaudit.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_MEP_AUDIT_DESCRIPTION =
  "Formcraft MEP connectivity and system audit (read-only: no transaction, no batch_lease, nothing is changed). " +
  "It adds to fmc_trace, it does not repeat it: (1) a cross-check of fmc_trace's open_end on piping and HVAC: " +
  "ConnectorManager.UnusedConnectors on pipes, ducts, flex, fittings, accessories, equipment, fixtures, sprinklers and " +
  "terminals (MEP-OPEN-*, info) and PlumbingUtils.HasOpenConnector both ways on piping (MEP-XCHK-MISMATCH where they " +
  "disagree); (2) IsWellConnected per piping and mechanical system; (3) systems with no BaseEquipment as a count plus ids; " +
  "(4) per system static pressure (Pa), PressureLossOfCriticalPath (Pa) and the critical-path sections in flow order " +
  "(MEPSection TotalPressureLoss, flow L/s, length m, velocity, size); (5) fixture units per piping system. Calculated values " +
  "are only valid on a well-connected system (calc_valid). Filters: domain piping, duct or both; systems (names or ids); " +
  "levels; include_equipment. mode summary (counts, error and warning issues, ids per code, systems with issues) or detail, " +
  "capped by max_results. " + EXCLUDED_DOMAINS_NOTE + " Pass document when more than one document is open.";

export const FMC_MEP_AUDIT_SHAPE = {
  document: z.string().optional().default("").describe("An open document's title or full path; required when more than one is open"),
  domain: z.enum(["piping", "duct", "both"]).optional().default("both").describe("piping, duct or both. Conduit and cable tray are never audited here."),
  systems: z.array(z.string()).optional().default([]).describe("Only these systems: names (case-insensitive) or element ids"),
  levels: z.array(z.string()).optional().default([]).describe("Only elements and systems on these levels (level names)"),
  include_equipment: z.boolean().optional().default(true).describe("Also report open connectors on equipment, fixtures, sprinklers and terminals"),
  analysis: z.boolean().optional().default(true).describe("Read flow, static pressure, critical-path loss and fixture units (slower on big models)"),
  mode: z.enum(["summary", "detail"]).optional().default("summary"),
  max_results: z.number().int().min(1).max(5000).optional().default(200).describe("Cap on issues and on systems in the reply"),
};

export type FmcMepAuditArgs = z.infer<z.ZodObject<typeof FMC_MEP_AUDIT_SHAPE>>;

export interface MepAuditIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
}

/** The body sent to the add-in. Read-only: there is no batch_lease and no dry_run. */
export function mepAuditBody(args: FmcMepAuditArgs) {
  return {
    document: args.document ?? "",
    domain: args.domain ?? "both",
    systems: args.systems ?? [],
    levels: args.levels ?? [],
    include_equipment: args.include_equipment ?? true,
    analysis: args.analysis ?? true,
  };
}

export async function runFmcMepAudit(args: FmcMepAuditArgs, io: MepAuditIo = {}) {
  const body = mepAuditBody(args);
  let snapshot: MepAuditSnapshot;
  try {
    snapshot = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_mep_audit", body, 300000))) as MepAuditSnapshot;
  } catch (error) {
    return reply({ tool: "fmc_mep_audit", schema: MEP_AUDIT_SCHEMA, read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  if (!snapshot || typeof snapshot !== "object" || (!Array.isArray(snapshot.open_connectors) && !Array.isArray(snapshot.systems))) {
    return reply({
      tool: "fmc_mep_audit", schema: MEP_AUDIT_SCHEMA, read_only: true,
      error: "The installed add-in returned no MEP audit snapshot. fmc_mep_audit needs the command set, then a Revit restart.",
    }, true);
  }
  const shaped = shapeMepAudit(snapshot, {
    domain: body.domain, systems: body.systems, levels: body.levels, include_equipment: body.include_equipment,
    mode: args.mode ?? "summary", max_results: args.max_results ?? 200,
  });
  return reply(shaped);
}

export function registerFmcMepAuditTool(server: McpServer) {
  server.tool("fmc_mep_audit", FMC_MEP_AUDIT_DESCRIPTION, FMC_MEP_AUDIT_SHAPE, (args) => runFmcMepAudit(args));
}
