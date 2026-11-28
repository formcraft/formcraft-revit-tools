import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

/** VI-4: say when verbose changed nothing, instead of implying a fuller reply. */
export function viewInfoShape(response: unknown, verbose: boolean): unknown {
  if (!verbose || !response || typeof response !== "object" || Array.isArray(response)) return response;
  return { ...(response as Record<string, unknown>), verbose_ignored: true, note: "verbose returns the same fields as the summary in this build." };
}

export function registerGetCurrentViewInfoTool(server: McpServer) {
  server.tool(
    "get_current_view_info",
    "The active Revit view (read-only): id, unique id, name, view type, template flag, scale and detail level. " +
      "Crop, view template, phase, discipline and filters are not read yet; verbose is accepted but returns the same object (verbose_ignored in the reply).",
    { verbose: z.boolean().optional().describe("Accepted for older callers; the add-in returns the same object either way (VI-4).") },
    async (args, extra) => {
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("get_current_view_info", args.verbose ? { verbose: true } : {});
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(viewInfoShape(response, args.verbose === true), null, 2),
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
