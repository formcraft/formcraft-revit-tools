import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { activePlanView } from "../fmc/basicwrites.js";

const text = (body: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

/**
 * viewId -1 is resolved here to the active view, only when that is a plan view, and sent as an explicit id: the add-in
 * never falls back to the active view silently. dry_run (default true) reports the view and the dimensions, no transaction.
 */
export async function runCreateDimensions(args: { dimensions: Array<Record<string, unknown> & { viewId?: number }>; dry_run?: boolean }, io: { send?: (command: string, params: Record<string, unknown>) => Promise<unknown> } = {}) {
  const send = io.send ?? ((command: string, params: Record<string, unknown>) => withRevitConnection((c) => c.sendCommand(command, params)));
  const needsActive = args.dimensions.some((d) => !(Number(d.viewId) > 0));
  let active: ReturnType<typeof activePlanView> | null = null;
  if (needsActive) {
    try { active = activePlanView(await send("get_current_view_info", {})); }
    catch (error) { active = { id: -1, name: "", type: "", problem: `The active view could not be read (${error instanceof Error ? error.message : String(error)}). Pass viewId.` }; }
    if (active.problem) return text({ refused: true, code: "FMC-DIM-VIEW", message: `${active.problem} Nothing was created.`, dry_run: args.dry_run !== false }, true);
  }
  const dimensions: Array<Record<string, unknown> & { viewId: number }> = args.dimensions.map((d) => ({ ...d, viewId: Number(d.viewId) > 0 ? Number(d.viewId) : active!.id }));
  if (args.dry_run !== false) {
    return text({
      dry_run: true, dimensions: dimensions.map((d, i) => ({ index: i, viewId: d.viewId, elementIds: d.elementIds ?? [], startPoint: d.startPoint, endPoint: d.endPoint })),
      ...(active ? { active_view: { id: active.id, name: active.name, type: active.type } } : {}),
      next: "Show the person the view and the dimensions; run again with dry_run false.",
    });
  }
  return text(await send("create_dimensions", { dimensions }));
}

export function registerCreateDimensionsTool(server: McpServer) {
  server.tool(
    "create_dimensions",
    "Create dimension annotations in a Revit view. Supports dimensioning between elements (walls, doors, windows) by element IDs, or between two points with automatic reference detection. All coordinates are in millimeters (mm). " +
      "viewId -1 means the active view and is refused unless that is a plan view; the view used is always named. dry_run defaults to true.",
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
                "Element ID of the view to create the dimension in. -1 for the active view, refused unless it is a plan view"
              ),
          })
        )
        .describe("Array of dimensions to create"),
      dry_run: z.boolean().optional().default(true).describe("Report the view and the dimensions; create nothing. Default true."),
    },
    async (args) => {
      try {
        return await runCreateDimensions(args);
      } catch (error) {
        return toolFailure(`Dimension creation failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
