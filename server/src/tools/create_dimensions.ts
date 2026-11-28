import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { planDimensions, type DimArgs, type RelativeTo } from "../fmc/datum.js";
import { DATUM_COMMON_SHAPE, runDatumTool, type DatumIo } from "./datum_common.js";

export async function runCreateDimensions(args: { dimensions: DimArgs[]; document?: string; dry_run?: boolean; relative_to?: RelativeTo }, io?: DatumIo) {
  const viewIds = [...new Set(args.dimensions.map((dim) => dim.viewId ?? -1).filter((id) => id > 0).map(String))];
  return runDatumTool({
    tool: "create_dimensions",
    command: "create_dimensions",
    document: args.document,
    dryRun: args.dry_run !== false,
    relativeTo: args.relative_to ?? "project_base_point",
    readBody: { view_ids: viewIds },
    plan: (snapshot, origin) => {
      const plan = planDimensions(args.dimensions, snapshot, origin);
      const sent = plan.items.filter((row) => row.status !== "error").map((row) => row.index);
      return { items: plan.items, errors: plan.errors, send: { dimensions: plan.dimensions }, sent };
    },
    io,
  });
}

export function registerCreateDimensionsTool(server: McpServer) {
  server.tool(
    "create_dimensions",
    "dry_run defaults to true: each dimension is checked and nothing is written. viewId is required (the active view is not a guess). Points are from the project base point unless relative_to is internal_origin. A repeated dimension is FMC-DIM-DUPLICATE; any error refuses the whole call. Every dimension has one row in items, created or failed with a code, never silently skipped. At most 50 per call. " +
    "Create dimension annotations in the current Revit view. Supports dimensioning between elements (walls, doors, windows) by element IDs, or between two points with automatic reference detection. All coordinates are in millimeters (mm).",
    {
      dimensions: z
        .array(
          z.object({
            startPoint: z
              .object({
                x: z.number().describe("X coordinate in mm"),
                y: z.number().describe("Y coordinate in mm"),
                z: z.number().describe("Z coordinate in mm"),
              })
              .describe("Start point of the dimension line (mm)"),
            endPoint: z
              .object({
                x: z.number().describe("X coordinate in mm"),
                y: z.number().describe("Y coordinate in mm"),
                z: z.number().describe("Z coordinate in mm"),
              })
              .describe("End point of the dimension line (mm)"),
            linePoint: z
              .object({
                x: z.number().describe("X coordinate in mm"),
                y: z.number().describe("Y coordinate in mm"),
                z: z.number().describe("Z coordinate in mm"),
              })
              .optional()
              .describe(
                "Location of the dimension line itself (mm). If not provided, defaults to midpoint offset by 1 foot"
              ),
            elementIds: z
              .array(z.number())
              .optional()
              .describe(
                "Element IDs to dimension between. If provided, references are extracted from these elements. If empty, references are auto-detected at start/end points"
              ),
            dimensionType: z
              .string()
              .optional()
              .default("Linear")
              .describe(
                "Dimension type (default: 'Linear')"
              ),
            dimensionStyleId: z
              .number()
              .optional()
              .default(-1)
              .describe(
                "Element ID of the dimension style to apply. -1 for default style"
              ),
            viewId: z
              .number()
              .optional()
              .default(-1)
              .describe(
                "Element ID of the view to create the dimension in. -1 for active view"
              ),
          })
        )
        .describe("Array of dimensions to create"),
      ...DATUM_COMMON_SHAPE,
      dry_run: z.boolean().optional().default(true).describe("true (default): each dimension is checked (view, length, references, repeats) and nothing is written."),
    },
    async (args) => {
      try {
        return await runCreateDimensions(args as Parameters<typeof runCreateDimensions>[0]);
      } catch (error) {
        return toolFailure(`Dimension creation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
