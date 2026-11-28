import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runDiagramTool, type DiagramArgs } from "../fmc/schematicrun.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_ELEC_DIAGRAMS_DESCRIPTION =
  "Formcraft electrical diagrams for an open model such as F26901-FMC-ZZ-ZZ-M3-E-0001_USER. " +
  "plan reads panels and circuits (the same graph fmc_trace collects) and returns drafting views: " +
  "a single-line diagram (boards, feeders, breakers with circuit number, rating, poles and load), " +
  "a power riser per building (boards stacked by level, feeders between them), and an earthing template. " +
  "riser bands spaces levels equally. riser elevation uses level height, 12 paper mm per metre. " +
  "A loaded kit family (FMC_DI_E_SLD_Board, FMC_DI_E_SLD_Breaker, or another FMC_DI_E_SLD_* Generic Annotation or Detail Item) is placed. Otherwise the view is lines and text. " +
  "A missing rating or load is TBC. The earthing view is a template and does not size the electrode. " +
  "dry_run defaults to true. apply with dry_run false needs batch_lease and references.kit, references.standards and references.rulebook. " +
  "That call is fmc_elec_diagrams_apply, one transaction, one subtransaction per view. The model is not saved. " +
  "Circuits on no read board are counted in counts.circuits_not_drawn with a warning. plan returns would_refuse when an apply would be refused. " +
  "Pass document. A protected project name (HEBERT HOSTELS, plus the guard's never_write_titles), a central model and a protected path are refused. " +
  "Example: action plan, document F26901-FMC-ZZ-ZZ-M3-E-0001_USER, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_ELEC_DIAGRAMS_SHAPE = {
  action: z.enum(["plan", "apply", "limits"]),
  document: z.string().optional().default("").describe("Title or full path of the open electrical model."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  riser: z.enum(["bands", "elevation"]).optional().default("bands"),
  include: z.array(z.enum(["sld", "riser", "earthing"])).optional()
    .describe("Views to plan. Default all, but the earthing template is skipped when no panels were read; name earthing to keep it."),
  references: refs,
};

const TOOL = { tool: "fmc_elec_diagrams" as const, readCommand: "fmc_elec_diagrams", applyCommand: "fmc_elec_diagrams_apply", discipline: "elec" as const };

export async function runFmcElecDiagrams(args: DiagramArgs, io: Parameters<typeof runDiagramTool>[2] = {}) {
  try {
    return await runDiagramTool(TOOL, args, io);
  } catch (error) {
    return reply({ tool: "fmc_elec_diagrams", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcElecDiagramsTool(server: McpServer) {
  server.tool("fmc_elec_diagrams", FMC_ELEC_DIAGRAMS_DESCRIPTION, FMC_ELEC_DIAGRAMS_SHAPE, async (args) => runFmcElecDiagrams(args as DiagramArgs));
}
