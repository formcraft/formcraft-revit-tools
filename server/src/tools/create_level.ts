import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { planLevels, type LevelRow } from "../fmc/basicwrites.js";

const text = (body: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

/** dry_run (default true): names, elevations, the views to be made and conflicts with the model's levels. No transaction. */
export async function runCreateLevel(args: { data: Array<LevelRow & Record<string, unknown>>; dry_run?: boolean }, io: { send?: (command: string, params: Record<string, unknown>) => Promise<unknown> } = {}) {
  const send = io.send ?? ((command: string, params: Record<string, unknown>) => withRevitConnection((c) => c.sendCommand(command, params)));
  if (args.dry_run !== false) {
    let existing: unknown = [];
    let read = true;
    try {
      existing = await send("ai_element_filter", { data: { filterCategory: "OST_Levels", includeInstances: true, includeTypes: false, maxElements: 2000 } });
    } catch { read = false; }
    const plan = planLevels(args.data, existing);
    return text({ dry_run: true, ...plan, existing_levels_read: read, next: "Show the person these levels and conflicts; run again with dry_run false." });
  }
  return text(await send("create_level", { data: args.data }));
}

export function registerCreateLevelTool(server: McpServer) {
  server.tool(
    "create_level",
    "Create one or more levels in Revit at specified elevations. Levels define horizontal planes in the building and are used to host floor plans, ceilings, and other level-based elements. All elevation units are in millimeters (mm). " +
      "dry_run defaults to true and lists names, elevations, the views to be made and conflicts with existing levels.",
    {
      data: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Name of the level (e.g., 'Level 2', 'Roof', 'Basement')"),
            elevation: z
              .number()
              .describe("Elevation of the level in millimeters (mm) from project origin"),
            description: z
              .string()
              .optional()
              .describe("Optional description of the level"),
            isMainLevel: z
              .boolean()
              .default(true)
              .describe("Whether this is a main level (default: true)"),
            isBuildingStory: z
              .boolean()
              .default(true)
              .describe("Whether this level represents a building story (default: true)"),
            computationHeight: z
              .number()
              .optional()
              .describe("Optional computation height in mm"),
            viewPlanOffset: z
              .number()
              .optional()
              .describe("Optional view plan offset in mm"),
            viewSectionOffset: z
              .number()
              .optional()
              .describe("Optional view section offset in mm"),
            viewElevationOffset: z
              .number()
              .optional()
              .describe("Optional view elevation offset in mm"),
            createFloorPlan: z
              .boolean()
              .default(true)
              .describe("Whether to create a floor plan view for this level (default: true)"),
            createCeilingPlan: z
              .boolean()
              .default(true)
              .describe("Whether to create a ceiling plan view for this level (default: true)"),
          })
        )
        .describe("Array of levels to create"),
      dry_run: z.boolean().optional().default(true).describe("List the plan and conflicts; create nothing. Default true."),
    },
    async (args) => {
      try {
        return await runCreateLevel(args);
      } catch (error) {
        return toolFailure(`Create level failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
