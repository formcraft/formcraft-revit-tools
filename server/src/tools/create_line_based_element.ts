import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { loadConfig } from "../fmc/policy.js";
import { loadAiConfig } from "../fmc/aiuse_io.js";
import { startedByFrom } from "../fmc/ledger.js";
import { adminSession, lineBatchRefusal } from "../fmc/linecat.js";

export function registerCreateLineBasedElementTool(server: McpServer) {
  server.tool(
    "create_line_based_element",
    "Create one or more line-based elements in Revit: walls (OST_Walls) and ducts (OST_DuctCurves). Structure (OST_StructuralFraming and the other structural categories) is admin-only, like create_structural_framing_system: an AI session is refused with FMC-LINE-CATEGORY-ADMIN, and any other category with FMC-LINE-CATEGORY-UNKNOWN. Supports batch creation with detailed parameters including family type ID, start and end points, thickness, height, and level information. All units are in millimeters (mm).",
    {
      data: z
        .array(
          z.object({
            category: z
              .string()
              .describe("Revit built-in category: OST_Walls or OST_DuctCurves (structural categories are admin-only)"),
            typeId: z
              .number()
              .optional()
              .describe("The ID of the family type to create."),
            locationLine: z
              .object({
                p0: z.object({
                  x: z.number().describe("X coordinate of start point"),
                  y: z.number().describe("Y coordinate of start point"),
                  z: z.number().describe("Z coordinate of start point"),
                }),
                p1: z.object({
                  x: z.number().describe("X coordinate of end point"),
                  y: z.number().describe("Y coordinate of end point"),
                  z: z.number().describe("Z coordinate of end point"),
                }),
              })
              .describe("The line defining the element's location"),
            thickness: z
              .number()
              .describe(
                "Thickness/width of the element (e.g., wall thickness)"
              ),
            height: z
              .number()
              .describe("Height of the element (e.g., wall height)"),
            baseLevel: z.number().describe("Base level height"),
            baseOffset: z.number().describe("Offset from the base level"),
          })
        )
        .describe("Array of line-based elements to create"),
    },
    async (args, extra) => {
      // The session's role is decided here, never by the caller: a client cannot send it (the schema strips unknown keys).
      const { config } = loadConfig();
      const admin = adminSession(loadAiConfig(config), startedByFrom(process.env, "ai"));
      const refusal = lineBatchRefusal(args.data, admin);
      if (refusal) return toolFailure(JSON.stringify({ refused: true, code: refusal.code, category: refusal.category, message: refusal.message }, null, 2));
      const params = { data: args.data, _category_admin: admin };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "create_line_based_element",
            params
          );
        });

        // The add-in refuses a batch whose resolved type is in a category this session may not make
        const refused = typeof response?.message === "string" && response.success === false && /\[FMC-LINE-CATEGORY-/.test(response.message);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
          ...(refused ? { isError: true as const } : {}),
        };
      } catch (error) {
        return toolFailure(`Create line-based element failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
