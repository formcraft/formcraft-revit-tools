import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { categoryNameProblem } from "../fmc/categorynames.js";

export function registerGetCurrentViewElementsTool(server: McpServer) {
  server.tool(
    "get_current_view_elements",
    "Get elements from the current active view in Revit. You can filter by model categories (OST_Walls, OST_Floors) or annotation categories (OST_Dimensions, OST_TextNotes); a name that is not an OST_ token is refused (FMC-CATEGORY-UNKNOWN), never read as every category. Use includeHidden to show/hide invisible elements and limit to control the number of returned elements.",
    {
      modelCategoryList: z
        .array(z.string())
        .optional()
        .describe(
          "List of Revit model category names (e.g., 'OST_Walls', 'OST_Doors', 'OST_Floors')"
        ),
      annotationCategoryList: z
        .array(z.string())
        .optional()
        .describe(
          "List of Revit annotation category names (e.g., 'OST_Dimensions', 'OST_WallTags', 'OST_TextNotes')"
        ),
      includeHidden: z
        .boolean()
        .optional()
        .describe("Whether to include hidden elements in the results"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of elements to return"),
    },
    async (args, extra) => {
      const params = {
        modelCategoryList: args.modelCategoryList || [],
        annotationCategoryList: args.annotationCategoryList || [],
        includeHidden: args.includeHidden || false,
        limit: args.limit || 100,
      };

      // VE-4: refuse names the add-in cannot parse instead of returning the unfiltered view.
      const badCategories = categoryNameProblem([...params.modelCategoryList, ...params.annotationCategoryList], "modelCategoryList / annotationCategoryList");
      if (badCategories) return { content: [{ type: "text" as const, text: JSON.stringify({ refused: true, ...badCategories }, null, 2) }], isError: true };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "get_current_view_elements",
            params
          );
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
        return toolFailure(`get current view elements failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
