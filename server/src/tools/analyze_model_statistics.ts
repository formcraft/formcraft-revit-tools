import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

export function registerAnalyzeModelStatisticsTool(server: McpServer) {
  server.tool(
    "analyze_model_statistics",
    "Analyze model complexity with element counts. Returns detailed statistics about the Revit model including total element counts, total types, total families, views, sheets, counts by category (with type/family breakdown), and level-by-level element distribution. Useful for model auditing, performance analysis, and understanding model composition.",
    {
      includeDetailedTypes: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include detailed breakdown by family and type within each category. Defaults to true."),
      verbose: z.boolean().optional().describe("Return the full statistics. Omit it for counts and ids."),
    },
    async (args, extra) => {
      const params = {
        includeDetailedTypes: args.includeDetailedTypes ?? true,
        ...(args.verbose ? { verbose: true } : {}),
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand("analyze_model_statistics", params);
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
        return toolFailure(`Analyze model statistics failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
