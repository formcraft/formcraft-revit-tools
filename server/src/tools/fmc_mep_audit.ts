import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { EXCLUDED_DOMAINS_NOTE, MEP_AUDIT_SCHEMA, shapeMepAudit, type MepAuditSnapshot } from "../fmc/mepaudit.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_MEP_AUDIT_DESCRIPTION =
  "Formcraft MEP connectivity and system audit (read-only: no transaction, no batch_lease, nothing is changed). " +
  "Checks: open (unused) End connectors on pipes, ducts, flex pipe and duct, their fittings and accessories " +
  "(ConnectorManager.UnusedConnectors, cross-checked with PlumbingUtils.HasOpenConnector on piping), and on mechanical " +
  "equipment, plumbing fixtures, sprinklers and air terminals; IsWellConnected per piping and mechanical system; systems " +
  "with no BaseEquipment (info for sanitary, vent and fire systems); empty or invalid systems; and per system flow (L/s), " +
  "static pressure (Pa), critical-path pressure loss (Pa, MEPSystem.PressureLossOfCriticalPath with the section numbers) " +
  "and fixture units (piping). Calculated values are only valid on a well-connected system (calc_valid). " +
  "Filters: domain piping, duct or both; systems (names or ids); levels (names); include_equipment. mode summary " +
  "(counts, error and warning issues, a sample of ids per code, systems with issues) or detail (every issue and system), " +
  "both capped by max_results. Issue codes are MEP-OPEN-*, MEP-CONN-NO-SYSTEM and MEP-SYS-*. The facts block feeds " +
  "fmc_calc (facts.mep merges into a facts_file mep section) and fmc_mep_size (facts.mep_systems). " +
  EXCLUDED_DOMAINS_NOTE + " Pass document when more than one document is open.";

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
