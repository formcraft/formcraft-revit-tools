import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runDiagramTool, type DiagramArgs } from "../fmc/schematicrun.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PLUMB_DIAGRAMS_DESCRIPTION =
  "Formcraft plumbing and drainage diagrams for an open model such as F26901-FMC-ZZ-ZZ-M3-P-0001_USER. " +
  "plan reads piping systems (the same system membership fmc_trace uses, without walking every connector) and returns drafting views: " +
  "a riser per system (stacks by level, branch counts, fixture counts, pipe sizes, vent stacks) and a schematic of that system. " +
  "riser bands spaces levels equally. riser elevation uses level height, 12 paper mm per metre. " +
  "A loaded kit family FMC_DI_P_Schematic (Generic Annotation or Detail Item) is placed. Otherwise the view is lines and text. " +
  "These drafting views replace a tiny 3D schematic: the 3D view is named in the plan and is not deleted. " +
  "Systems are taken in name order, at most 16 per call: systems [names or ids] picks them and offset/limit pages them; the reply's selection lists what was not drawn. " +
  "Drainage systems show fall (pipe slope %) and fixture units when the add-in reads them, otherwise TBC. connector_input carries per-system facts for a plumbing connector. " +
  "summary is one line at the top. limits lists only the plumbing API limits. " +
  "A missing pipe size is TBC. dry_run defaults to true. apply with dry_run false needs batch_lease and references.kit, references.standards and references.rulebook. " +
  "That call is fmc_plumb_diagrams_apply, one transaction, one subtransaction per view. The model is not saved. " +
  "Pass document. HEBERT HOSTELS, a central model and a protected path are refused. " +
  "Example: action plan, document F26901-FMC-ZZ-ZZ-M3-P-0001_USER, riser elevation, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_PLUMB_DIAGRAMS_SHAPE = {
  action: z.enum(["plan", "apply", "limits"]),
  document: z.string().optional().default("").describe("Title or full path of the open plumbing model."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  riser: z.enum(["bands", "elevation"]).optional().default("bands"),
  references: refs,
  systems: z.array(z.string()).optional().describe("Piping system names or ids to draw. Empty draws all, 16 at a time."),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(16).optional().default(16),
};

const TOOL = { tool: "fmc_plumb_diagrams" as const, readCommand: "fmc_plumb_diagrams", applyCommand: "fmc_plumb_diagrams_apply", discipline: "plumb" as const };

export async function runFmcPlumbDiagrams(args: DiagramArgs, io: Parameters<typeof runDiagramTool>[2] = {}) {
  try {
    return await runDiagramTool(TOOL, args, io);
  } catch (error) {
    return reply({ tool: "fmc_plumb_diagrams", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcPlumbDiagramsTool(server: McpServer) {
  server.tool("fmc_plumb_diagrams", FMC_PLUMB_DIAGRAMS_DESCRIPTION, FMC_PLUMB_DIAGRAMS_SHAPE, async (args) => runFmcPlumbDiagrams(args as DiagramArgs));
}
