import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

export function registerGetCurrentViewElementsTool(server: McpServer) {
  server.tool(
    "get_current_view_elements",
    "Get elements from the current active view in Revit. You can filter by model categories (OST_Walls, OST_Floors) or annotation categories (OST_Dimensions, OST_TextNotes); pass BuiltInCategory names, unknown names are refused. The reply lists CategoriesApplied. Use includeHidden to show/hide invisible elements and limit to control the number of returned elements.",
    {
      modelCategoryList: z
        .array(z.string())
        .optional()
        .describe(
          "List of BuiltInCategory names (e.g., 'OST_Walls', 'OST_Doors', 'OST_Floors'). A name that is not a BuiltInCategory (such as 'Walls') is refused with FMC-BAD-CATEGORY; the filter is never widened to all categories."
        ),
      annotationCategoryList: z
        .array(z.string())
        .optional()
        .describe(
          "List of BuiltInCategory names for annotation (e.g., 'OST_Dimensions', 'OST_WallTags', 'OST_TextNotes'). Unknown names are refused (FMC-BAD-CATEGORY)."
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
