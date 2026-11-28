import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { namesOf, planGrid, type GridArgs } from "../fmc/basicwrites.js";

export interface BasicWriteIo { send?: (command: string, params: Record<string, unknown>) => Promise<unknown> }

const text = (body: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

/** dry_run (default true) lists the final names and positions; a real run refuses a name that exists instead of renaming it. */
export async function runCreateGrid(args: GridArgs & { dry_run?: boolean }, io: BasicWriteIo = {}) {
  const send = io.send ?? ((command: string, params: Record<string, unknown>) => withRevitConnection((c) => c.sendCommand(command, params)));
  const dry = args.dry_run !== false;
  let existing: string[] | null = null;
  try {
    existing = namesOf(await send("ai_element_filter", { data: { filterCategory: "OST_Grids", includeInstances: true, includeTypes: false, maxElements: 10000 } }));
  } catch (error) {
    if (!dry) return text({ refused: true, code: "FMC-GRID-READ", message: `The model's grid names could not be read, so a duplicate cannot be ruled out. Nothing was created. ${error instanceof Error ? error.message : String(error)}` }, true);
  }
  const plan = planGrid(args, existing ?? []);
  if (dry) {
    return text({
      dry_run: true, grids: plan.grids, duplicates: plan.duplicates, existing_names_read: existing !== null,
      next: plan.duplicates.length
        ? `Grid name(s) ${plan.duplicates.join(", ")} already exist or repeat: a real run refuses them (it no longer renames A to A1). Pick other start labels.`
        : "Show the person these names and positions; run again with dry_run false.",
    });
  }
  if (plan.duplicates.length) {
    return text({ refused: true, code: "FMC-GRID-DUPLICATE", message: `Grid name(s) ${plan.duplicates.join(", ")} already exist or repeat. Nothing was created; nothing was renamed.`, grids: plan.grids }, true);
  }
  const { dry_run: _dry, ...params } = args;
  return text(await send("create_grid", { ...params, onDuplicate: "refuse" }));
}

export function registerCreateGridTool(server: McpServer) {
  server.tool(
    "create_grid",
    "Create a grid system in Revit with smart spacing generation. Supports both X-axis (vertical) and Y-axis (horizontal) grids with customizable naming styles (alphabetic A,B,C or numeric 1,2,3). All units are in millimeters (mm). " +
      "dry_run defaults to true and lists the final names, positions and extents; a name that already exists is refused, never renamed (A to A1).",
    {
      xCount: z
        .number()
        .int()
        .positive()
        .describe("Number of grid lines along X-axis (vertical grids)"),
      xSpacing: z
        .number()
        .positive()
        .describe("Spacing between X-axis grid lines in millimeters"),
      xStartLabel: z
        .string()
        .default("A")
        .describe("Starting label for X-axis grids (e.g., 'A' or '1')"),
      xNamingStyle: z
        .enum(["alphabetic", "numeric"])
        .default("alphabetic")
        .describe("Naming style for X-axis: 'alphabetic' (A,B,C...) or 'numeric' (1,2,3...)"),
      yCount: z
        .number()
        .int()
        .positive()
        .describe("Number of grid lines along Y-axis (horizontal grids)"),
      ySpacing: z
        .number()
        .positive()
        .describe("Spacing between Y-axis grid lines in millimeters"),
      yStartLabel: z
        .string()
        .default("1")
        .describe("Starting label for Y-axis grids (e.g., '1' or 'A')"),
      yNamingStyle: z
        .enum(["alphabetic", "numeric"])
        .default("numeric")
        .describe("Naming style for Y-axis: 'alphabetic' (A,B,C...) or 'numeric' (1,2,3...)"),
      xExtentMin: z
        .number()
        .default(0)
        .describe("Minimum extent along X-axis in mm (where Y-axis grids start)"),
      xExtentMax: z
        .number()
        .default(50000)
        .describe("Maximum extent along X-axis in mm (where Y-axis grids end)"),
      yExtentMin: z
        .number()
        .default(0)
        .describe("Minimum extent along Y-axis in mm (where X-axis grids start)"),
      yExtentMax: z
        .number()
        .default(50000)
        .describe("Maximum extent along Y-axis in mm (where X-axis grids end)"),
      elevation: z
        .number()
        .default(0)
        .describe("Elevation for grid lines in mm (Z-coordinate)"),
      xStartPosition: z
        .number()
        .default(0)
        .describe("Starting position for first X-axis grid in mm"),
      yStartPosition: z
        .number()
        .default(0)
        .describe("Starting position for first Y-axis grid in mm"),
      dry_run: z.boolean().optional().default(true).describe("List the final names and positions; create nothing. Default true."),
    },
    async (args) => {
      try {
        return await runCreateGrid(args);
      } catch (error) {
        return toolFailure(`Create grid failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
