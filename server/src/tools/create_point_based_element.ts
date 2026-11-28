import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { planPoints, type PointArgs, type RelativeTo } from "../fmc/datum.js";
import { DATUM_COMMON_SHAPE, runDatumTool, type DatumIo } from "./datum_common.js";

export async function runCreatePointBasedElement(args: { data: PointArgs[]; document?: string; dry_run?: boolean; relative_to?: RelativeTo }, io?: DatumIo) {
  const typeIds = [...new Set(args.data.map((row) => row.typeId).filter((id): id is number => typeof id === "number" && id > 0).map(String))];
  return runDatumTool({
    tool: "create_point_based_element",
    command: "create_point_based_element",
    document: args.document,
    dryRun: args.dry_run === true,
    relativeTo: args.relative_to ?? "project_base_point",
    readBody: { type_ids: typeIds },
    plan: (snapshot, origin) => {
      const plan = planPoints(args.data, snapshot, origin);
      const sent = plan.items.filter((row) => row.status !== "error").map((row) => row.index);
      return { items: plan.items, errors: plan.errors, send: { data: plan.data }, sent };
    },
    io,
  });
}

export function registerCreatePointBasedElementTool(server: McpServer) {
  server.tool(
    "create_point_based_element",
    "locationPoint and baseLevel are from the project base point unless relative_to is internal_origin. An instance of the same type within 10 mm of the point, or a repeated item, is FMC-PLACE-DUPLICATE and refuses the whole call. Every item has one row in items: created with its id, or failed with a code (no type, no level, host, not created), never silently skipped. dry_run true checks and writes nothing. " +
    "Create one or more point-based elements in Revit such as doors, windows, or furniture. Supports batch creation with detailed parameters including family type ID, position, dimensions, and level information. All units are in millimeters (mm).",
    {
      data: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Description of the element (e.g., door, window)"),
            typeId: z
              .number()
              .optional()
              .describe("The ID of the family type to create."),
            locationPoint: z
              .object({
                x: z.number().describe("X coordinate"),
                y: z.number().describe("Y coordinate"),
                z: z.number().describe("Z coordinate"),
              })
              .describe(
                "The position coordinates where the element will be placed"
              ),
            width: z.number().describe("Width of the element in mm"),
            depth: z.number().optional().describe("Depth of the element in mm"),
            height: z.number().describe("Height of the element in mm"),
            baseLevel: z.number().describe("Base level height"),
            baseOffset: z.number().describe("Offset from the base level"),
            rotation: z
              .number()
              .optional()
              .describe("Rotation angle in degrees (0-360)"),
            hostWallId: z
              .number()
              .optional()
              .describe(
                "The ElementId of a specific wall to use as host for doors/windows. " +
                "If not provided, the nearest wall will be auto-detected."
              ),
            facingFlipped: z
              .boolean()
              .optional()
              .default(false)
              .describe(
                "Whether to flip the facing direction of the door/window. " +
                "When true, the element faces the opposite side of the wall."
              ),
          })
        )
        .describe("Array of point-based elements to create"),
      ...DATUM_COMMON_SHAPE,
      dry_run: z.boolean().optional().default(false).describe("true: check every item (duplicates, base point) and write nothing."),
    },
    async (args) => {
      try {
        return await runCreatePointBasedElement(args as Parameters<typeof runCreatePointBasedElement>[0]);
      } catch (error) {
        return toolFailure(`Create point-based element failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
