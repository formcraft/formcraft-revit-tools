import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { planLevels, type LevelArgs, type OnDuplicate, type RelativeTo } from "../fmc/datum.js";
import { DATUM_COMMON_SHAPE, runDatumTool, type DatumIo } from "./datum_common.js";

export async function runCreateLevel(args: { data: LevelArgs[]; document?: string; dry_run?: boolean; relative_to?: RelativeTo; on_duplicate?: OnDuplicate }, io?: DatumIo) {
  const onDuplicate: OnDuplicate = args.on_duplicate === "reuse" ? "reuse" : "error";
  return runDatumTool({
    tool: "create_level",
    command: "create_level",
    document: args.document,
    dryRun: args.dry_run !== false,
    relativeTo: args.relative_to ?? "project_base_point",
    readBody: { levels: true },
    plan: (snapshot, origin) => {
      const plan = planLevels(args.data, snapshot, origin, onDuplicate);
      const sent = plan.items.filter((row) => row.status !== "error").map((row) => row.index);
      return { items: plan.items, errors: plan.errors, send: { data: plan.data, onDuplicate: plan.onDuplicate }, sent };
    },
    io,
  });
}

export function registerCreateLevelTool(server: McpServer) {
  server.tool(
    "create_level",
    "dry_run defaults to true: names, elevations and clashes are returned and nothing is written. Elevations are from the project base point unless relative_to is internal_origin. An existing or repeated name is FMC-LEVEL-DUPLICATE, and a level at the height of another is FMC-LEVEL-SAME-ELEVATION; either refuses the whole call. Every level has one row in items. " +
    "Create one or more levels in Revit at specified elevations. Levels define horizontal planes in the building and are used to host floor plans, ceilings, and other level-based elements. All elevation units are in millimeters (mm).",
    {
      data: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Name of the level (e.g., 'Level 2', 'Roof', 'Basement')"),
            elevation: z
              .number()
              .describe("Elevation of the level in mm, from the project base point (relative_to project_base_point, default) or the internal origin"),
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
      ...DATUM_COMMON_SHAPE,
      dry_run: z.boolean().optional().default(true).describe("true (default): plan only, nothing is written."),
      on_duplicate: z.enum(["error", "reuse"]).optional().default("error").describe("error (default): an existing or repeated name refuses the call. reuse: the existing level is kept and reported."),
    },
    async (args) => {
      try {
        return await runCreateLevel(args as Parameters<typeof runCreateLevel>[0]);
      } catch (error) {
        return toolFailure(`Create level failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
