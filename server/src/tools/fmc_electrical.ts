import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ELEC_PARAMS, kitChangeRequest, planEnrich, planSizing, readKitParameterNames, sizingWrites } from "../fmc/electrical.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_ELECTRICAL_DESCRIPTION =
  "Formcraft electrical (F79, E3): enrich load data and draft feeder sizes from facts you pass in. Read-only: it never changes a model and writes no files; it returns parameter values and a CSV (ElementId plus one column per parameter) that fmc_params can fill after a person approves. " +
  "Everything is a DRAFT for the engineer to check and sign: the engineer's name is left empty, and Formcraft never picks a demand factor, power factor, cable table, derating or voltage-drop limit. A missing input is TBC, never a default. " +
  "action kit_request: the 16 electrical parameters FormCraft Electrical writes that the kit lacks, as a kit change request with values marked assumed (rule 7). Pass shared_parameter_file (the kit's) so parameters already there are left out. " +
  "action enrich: devices [{id, va or watts+power_factor, phases, voltage_v, load_class}] become FMC_E_ values, only for parameters the kit file has; the rest are listed as skipped. " +
  "action size: circuits [{id, name, connected_va, voltage_v, phases, length_m, demand_factor}] plus inputs {cable_table [{size_mm2, rating_a, mv_per_a_m}], breaker_ratings_a, vd_limit_percent, derating, demand_factor} give a draft breaker, cable and voltage drop per circuit, or the TBC list. " +
  "Example: action size, circuits [{id: 11, name: \"L1\", connected_va: 3000, voltage_v: 230, phases: 1, length_m: 25}], inputs from the engineer.";

const device = z.object({
  id: z.union([z.string(), z.number()]), name: z.string().optional(), category: z.string().optional(),
  va: z.number().nullable().optional(), watts: z.number().nullable().optional(), power_factor: z.number().nullable().optional(),
  phases: z.number().nullable().optional(), voltage_v: z.number().nullable().optional(), load_class: z.string().nullable().optional(),
});
const circuit = z.object({
  id: z.union([z.string(), z.number()]), name: z.string().optional(), connected_va: z.number(), voltage_v: z.number(),
  phases: z.union([z.literal(1), z.literal(3)]), length_m: z.number().nullable().optional(), demand_factor: z.number().nullable().optional(), power_factor: z.number().nullable().optional(),
});

export const FMC_ELECTRICAL_SHAPE = {
  action: z.enum(["kit_request", "enrich", "size"]).describe("kit_request, enrich or size."),
  shared_parameter_file: z.string().optional().default("").describe("The kit's shared parameter file (read-only). Parameters in it are treated as in the kit."),
  devices: z.array(device).optional().default([]),
  circuits: z.array(circuit).optional().default([]),
  inputs: z.object({
    cable_table: z.array(z.object({ size_mm2: z.number(), rating_a: z.number(), mv_per_a_m: z.number() })).optional(),
    breaker_ratings_a: z.array(z.number()).optional(),
    vd_limit_percent: z.number().nullable().optional(),
    derating: z.number().nullable().optional(),
    demand_factor: z.number().nullable().optional(),
  }).optional().default({}),
};

export type FmcElectricalArgs = z.infer<z.ZodObject<typeof FMC_ELECTRICAL_SHAPE>>;

export async function runFmcElectrical(args: FmcElectricalArgs) {
  const stamp = (extra: object) => ({ tool: "fmc_electrical", read_only: true, saved: false, synced: false, images: [] as [], ...extra });
  try {
    const kit = readKitParameterNames(args.shared_parameter_file);
    const notes = kit.problem ? [kit.problem] : [];
    if (args.action === "kit_request") return reply(stamp({ action: args.action, request: kitChangeRequest(kit.names), notes, parameters: ELEC_PARAMS.length }));
    if (args.action === "enrich") {
      if (!args.devices.length) return reply(stamp({ refused: true, code: "FMC-ELEC-INPUT", message: "[FMC-ELEC-INPUT] enrich needs devices." }), true);
      return reply(stamp({ action: args.action, notes, ...planEnrich(args.devices, kit.names) }));
    }
    if (!args.circuits.length) return reply(stamp({ refused: true, code: "FMC-ELEC-INPUT", message: "[FMC-ELEC-INPUT] size needs circuits." }), true);
    const plan = planSizing(args.circuits, args.inputs);
    const ids: Record<string, string> = {};
    for (const c of args.circuits) ids[String(c.name ?? c.id)] = String(c.id);
    return reply(stamp({ action: args.action, notes, ...plan, parameters: sizingWrites(plan.circuits, ids, kit.names) }));
  } catch (error) {
    return reply(stamp({ refused: true, code: "FMC-ELEC", message: error instanceof Error ? error.message : String(error) }), true);
  }
}

export function registerFmcElectricalTool(server: McpServer) {
  server.tool("fmc_electrical", FMC_ELECTRICAL_DESCRIPTION, FMC_ELECTRICAL_SHAPE, async (args) => runFmcElectrical(args as FmcElectricalArgs));
}