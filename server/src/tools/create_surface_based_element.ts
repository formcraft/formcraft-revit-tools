import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

export function registerCreateSurfaceBasedElementTool(server: McpServer) {
  server.tool(
    "create_surface_based_element",
    "Create one or more surface-based elements in Revit such as floors, ceilings, or roofs. Supports batch creation with detailed parameters including family type ID, boundary lines, thickness, and level information. All units are in millimeters (mm). typeId is used as given, or refused when it is missing or not a floor, roof or ceiling type (the first type is never used in its place); with no typeId the one type whose total thickness equals thickness is used, and none or several is refused (FMC-TYPE-NO-THICKNESS-MATCH, FMC-TYPE-AMBIGUOUS). A thickness that differs from the given type is refused (FMC-TYPE-THICKNESS-MISMATCH). No type is created: make one with modify_model duplicate_type. The answer has one row per item in Items.",
    {
      data: z
        .array(
          z.object({
            name: z
              .string()
              .describe("Description of the element (e.g., floor, ceiling)"),
            category: z
              .enum(["OST_Floors", "OST_Ceilings", "OST_Roofs"])
              .optional()
              .describe("The Revit built-in category for the element. Use OST_Floors for floors, OST_Ceilings for ceilings, OST_Roofs for roofs. If not specified, will be determined from typeId."),
            typeId: z
              .number()
              .optional()
              .describe("The ID of the family type to create."),
            boundary: z
              .object({
                outerLoop: z
                  .array(
                    z.object({
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
                  )
                  .min(3)
                  .describe("Array of line segments defining the boundary"),
              })
              .describe("Boundary definition with outer loop"),
            thickness: z.number().describe("Thickness of the element"),
            baseLevel: z.number().describe("Base level height"),
            baseOffset: z.number().describe("Offset from the base level"),
          })
        )
        .describe("Array of surface-based elements to create"),
    },
    async (args, extra) => {
      const params = args;
      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "create_surface_based_element",
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
        return toolFailure(`Create surface-based element failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
