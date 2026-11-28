import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

export function registerGetCurrentViewInfoTool(server: McpServer) {
  server.tool(
    "get_current_view_info",
    "The active Revit view (read-only). The summary is Id, UniqueId, Name, ViewType, IsTemplate, Scale, DetailLevel. With verbose:true the reply adds Verbose:true, Title, CropBoxActive, CropBoxVisible, ViewTemplateId/Name, PhaseId/Name, PhaseFilter, Discipline, GenLevelId/Name, DisplayStyle and Filters (id, name, visible, enabled); a property the view type does not have is null.",
    { verbose: z.boolean().optional().describe("Add crop, template, phase, discipline, level, display style and view filters. Omit it for the summary.") },
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
