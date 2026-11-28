import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

export function registerGetSelectedElementsTool(server: McpServer) {
  server.tool(
    "get_selected_elements",
    "Get elements currently selected in Revit. Returns {document, count, limit, truncated, elements}: count is the whole selection, elements is capped by limit (default 100), truncated is true when the cap hid some. A document that is not the active window is an error (FMC-DOC-REQUIRED), not an empty list.",
    {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of elements to return (default 100). count still reports the whole selection."),
    },
    async (args, extra) => {
      const params = {
        limit: args.limit || 100,
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_selected_elements", params);
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
        return toolFailure(`get selected elements failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
