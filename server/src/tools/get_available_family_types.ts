import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

/** GT-1: one object for compact and verbose: count, verbose, limit, truncated (the limit was reached), ids or types, resolved_document. */
export function familyTypesShape(response: unknown, limit: number, verbose: boolean): unknown {
  const body = Array.isArray(response) ? { count: response.length, types: response } : response;
  if (!body || typeof body !== "object") return body;
  const row = body as Record<string, unknown>;
  const count = typeof row.count === "number" ? row.count : 0;
  return { ...row, verbose, limit, truncated: count >= limit, ...(verbose ? {} : { note: "ids are the first 40; verbose true returns every type up to limit." }) };
}

export function registerGetAvailableFamilyTypesTool(server: McpServer) {
  server.tool(
    "get_available_family_types",
    "Get available family types in the current Revit project. You can filter by category and family name, and limit the number of returned types.",
    {
      categoryList: z
        .array(z.string())
        .optional()
        .describe(
          "List of Revit category names to filter by (e.g., 'OST_Walls', 'OST_Doors', 'OST_Furniture')"
        ),
      familyNameFilter: z
        .string()
        .optional()
        .describe("Filter family types by family name (partial match)"),
      limit: z
        .number()
        .optional()
        .describe("Maximum number of family types to return"),
      verbose: z.boolean().optional().describe("Return every type. Omit it for counts and ids."),
    },
    async (args, extra) => {
      const params = {
        categoryList: args.categoryList || [],
        familyNameFilter: args.familyNameFilter || "",
        limit: args.limit || 100,
        ...(args.verbose ? { verbose: true } : {}),
      };

      try {
        const response = await withRevitConnection(async (revitClient) => {
          return await revitClient.sendCommand(
            "get_available_family_types",
            params
          );
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(familyTypesShape(response, params.limit, args.verbose === true), null, 2),
            },
          ],
        };
      } catch (error) {
        return toolFailure(`get available family types failed: ${
                error instanceof Error ? error.message : String(error)
              }`);
      }
    }
  );
}
