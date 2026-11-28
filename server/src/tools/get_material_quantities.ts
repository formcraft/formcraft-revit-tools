import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { categoryNameProblem } from "../fmc/categorynames.js";

export function registerGetMaterialQuantitiesTool(server: McpServer) {
  server.tool(
    "get_material_quantities",
    "Calculate material quantities and takeoffs from the current Revit project. Returns detailed information about each material including name, class, area, volume, and element counts. Useful for cost estimation, material ordering, and sustainability analysis.",
    {
      categoryFilters: z
        .array(z.string())
        .optional()
        .describe("Optional list of Revit category names to filter by (e.g., ['OST_Walls', 'OST_Floors', 'OST_Roofs']). If not specified, all categories are included. A name that is not an OST_ token is refused (FMC-CATEGORY-UNKNOWN), never read as the whole project."),
      selectedElementsOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to only analyze currently selected elements. Defaults to false (analyze entire project)."),
    },
    async (args, extra) => {
      const params = {
        categoryFilters: args.categoryFilters ?? null,
        selectedElementsOnly: args.selectedElementsOnly ?? false,
      };

      // MQ-3: a list where no name parses used to quantify the whole project with success true.
      const badCategories = categoryNameProblem(params.categoryFilters, "categoryFilters");
      if (badCategories) return { content: [{ type: "text" as const, text: JSON.stringify({ refused: true, ...badCategories }, null, 2) }], isError: true };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_material_quantities", params);
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        return toolFailure(`Get material quantities failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
