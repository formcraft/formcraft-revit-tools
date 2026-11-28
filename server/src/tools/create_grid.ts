import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { planGrids, type GridArgs, type OnDuplicate, type RelativeTo } from "../fmc/datum.js";
import { DATUM_COMMON_SHAPE, runDatumTool, type DatumIo } from "./datum_common.js";

export async function runCreateGrid(args: GridArgs & { document?: string; dry_run?: boolean; relative_to?: RelativeTo; on_duplicate?: OnDuplicate }, io?: DatumIo) {
  const onDuplicate: OnDuplicate = args.on_duplicate === "rename" ? "rename" : "error";
  const { document, dry_run, relative_to, on_duplicate: _d, ...grid } = args;
  return runDatumTool({
    tool: "create_grid",
    command: "create_grid",
    document,
    dryRun: dry_run !== false,
    relativeTo: relative_to ?? "project_base_point",
    readBody: { grids: true },
    plan: (snapshot, origin) => {
      const plan = planGrids(grid as GridArgs, snapshot, origin, onDuplicate);
      return { items: plan.items, errors: plan.errors, send: plan.params, sent: plan.items.map((row) => row.index) };
    },
    io,
  });
}

export function registerCreateGridTool(server: McpServer) {
  server.tool(
    "create_grid",
    "dry_run defaults to true: the names, positions and clashes are returned and nothing is written. Positions and extents are measured from the project base point unless relative_to is internal_origin. A name that exists, or repeats, is FMC-GRID-DUPLICATE and the whole call is refused (on_duplicate rename keeps the old A to A1 renaming, reported per grid). Every grid has one row in items. At most 200 lines per call. " +
    "Create a grid system in Revit with smart spacing generation. Supports both X-axis (vertical) and Y-axis (horizontal) grids with customizable naming styles (alphabetic A,B,C or numeric 1,2,3). All units are in millimeters (mm).",
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
      ...DATUM_COMMON_SHAPE,
      dry_run: z.boolean().optional().default(true).describe("true (default): plan only, nothing is written."),
      on_duplicate: z.enum(["error", "rename"]).optional().default("error").describe("error (default): an existing or repeated name refuses the call. rename: A becomes A1, reported."),
    },
    async (args) => {
      try {
        return await runCreateGrid(args as Parameters<typeof runCreateGrid>[0]);
      } catch (error) {
        return toolFailure(`Create grid failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
