import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

const FEET_TO_MM = 304.8;

/**
 * Tool research 1-25: level elevations are millimetres (elevationMm), never Revit's internal feet. A newer add-in sends
 * elevationMm; an add-in from before this change sends elevation in feet, converted here (the server installs without
 * closing Revit, the add-in only at the next close, so both can meet). Every level is returned; none is dropped.
 */
export function levelsInMm(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const body = { ...(node as Record<string, unknown>) };
    if (Array.isArray(body.levels)) {
      body.levels = body.levels.map((row) => {
        if (!row || typeof row !== "object") return row;
        const level = { ...(row as Record<string, unknown>) };
        if (typeof level.elevationMm !== "number" && typeof level.elevation === "number") {
          level.elevationMm = Math.round(level.elevation * FEET_TO_MM * 10) / 10;
          level.elevation_converted_from_feet = true;
          delete level.elevation;
        }
        return level;
      });
      body.lengthUnit = "mm";
    }
    for (const [key, value] of Object.entries(body)) if (key !== "levels" && value && typeof value === "object") body[key] = walk(value);
    return body;
  };
  return walk(response);
}

export function registerAnalyzeModelStatisticsTool(server: McpServer) {
  server.tool(
    "analyze_model_statistics",
    "Analyze model complexity with element counts. Returns detailed statistics about the Revit model including total element counts, total types, total families, views, sheets, counts by category (with type/family breakdown), and level-by-level element distribution (levels[].elevationMm and projectElevationMm in millimetres, never feet). Useful for model auditing, performance analysis, and understanding model composition.",
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
        }).then(levelsInMm);

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
