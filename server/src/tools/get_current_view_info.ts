import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

export function registerGetCurrentViewInfoTool(server: McpServer) {
  server.tool(
    "get_current_view_info",
    "The active Revit view: its type, name, scale, detail level and other properties (read-only). Omit verbose for the summary.",
    { verbose: z.boolean().optional().describe("Return every property. Omit it for the summary.") },
    async (args, extra) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_current_view_info", args.verbose ? { verbose: true } : {});
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
        return toolFailure(`get current view info failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
