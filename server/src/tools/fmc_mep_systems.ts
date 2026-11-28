import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { writeReport } from "../fmc/localreport.js";
import { filterSystems, routingCoverage, summarise, type SystemsSnapshot } from "../fmc/mepsystems.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_MEP_SYSTEMS_DESCRIPTION =
  "Formcraft duct and piping systems (read-only, no transaction). Actions: list (mechanical and piping systems with system type, " +
  "classification, base equipment, element count, and Revit's flow, static pressure and fixture units where it computes them), " +
  "types (the duct and piping system types), routing (the routing preferences of every duct and pipe type, read only, and which " +
  "groups have no rule, so a route knows up front which fittings Revit cannot place). Editing types or routing preferences is " +
  "modify_model's (the system-type editor); connectivity, IsWellConnected and critical path are fmc_mep_audit's; open ends are fmc_trace's. " +
  "Pass document when more than one document is open. The full list is JSON under %LOCALAPPDATA%\\Formcraft\\mep_systems.";

export const FMC_MEP_SYSTEMS_SHAPE = {
  action: z.enum(["list", "types", "routing"]),
  domain: z.enum(["duct", "piping", "both"]).optional().default("both"),
  name: z.string().optional().default(""),
  classification: z.string().optional().default(""),
  sample_limit: z.number().int().min(1).max(200).optional().default(40),
};

export type FmcMepSystemsArgs = z.infer<z.ZodObject<typeof FMC_MEP_SYSTEMS_SHAPE>>;

export interface MepSystemsIo { read?: (body: Record<string, unknown>) => Promise<unknown>; env?: NodeJS.ProcessEnv }

export async function runFmcMepSystems(args: FmcMepSystemsArgs, io: MepSystemsIo = {}) {
  const body = { domain: args.domain, routing: args.action === "routing" };
  let snapshot: SystemsSnapshot;
  try {
    snapshot = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_mep_systems", body, 300000))) as SystemsSnapshot;
  } catch (error) {
    return reply({ tool: "fmc_mep_systems", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  const base = { tool: "fmc_mep_systems", read_only: true, action: args.action, document: snapshot.resolved_document ?? { title: snapshot.model ?? "", path: "" } };
  const sample = args.sample_limit;
  if (args.action === "types") return reply({ ...base, system_types: snapshot.system_types ?? [] });
  if (args.action === "routing") {
    const coverage = (snapshot.curve_types ?? []).map(routingCoverage);
    const report = writeReport("mep_systems", "routing", { curve_types: snapshot.curve_types ?? [], coverage }, io.env);
    return reply({ ...base, coverage: coverage.slice(0, sample), not_ready: coverage.filter((c) => !c.ready).length, capped: coverage.length > sample, report,
      note: "Read only. To add a missing rule use modify_model edit_type routing (the system-type editor)." });
  }
  const rows = filterSystems(snapshot.systems ?? [], { name: args.name, classification: args.classification });
  const report = writeReport("mep_systems", "list", { systems: rows }, io.env);
  return reply({ ...base, summary: summarise(snapshot), matched: rows.length, systems: rows.slice(0, sample), capped: rows.length > sample, report });
}

export function registerFmcMepSystemsTool(server: McpServer) {
  server.tool("fmc_mep_systems", FMC_MEP_SYSTEMS_DESCRIPTION, FMC_MEP_SYSTEMS_SHAPE, (args) => runFmcMepSystems(args));
}
