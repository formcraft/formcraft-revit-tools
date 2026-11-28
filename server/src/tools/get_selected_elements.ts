import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";

/** GSE-3: one object: count, limit, truncated (the limit was reached, there may be more), elements, resolved_document. */
export function selectedShape(response: unknown, limit: number): unknown {
  const body = Array.isArray(response) ? { count: response.length, elements: response } : response;
  if (!body || typeof body !== "object") return body;
  const row = body as Record<string, unknown>;
  const count = typeof row.count === "number" ? row.count : 0;
  return { ...row, limit, truncated: count >= limit, ...(count >= limit ? { note: `The list stopped at limit ${limit}; more may be selected.` } : {}) };
}

export function registerGetSelectedElementsTool(server: McpServer) {
  server.tool(
    "get_selected_elements",
    "Get elements currently selected in Revit. You can limit the number of returned elements. The reply is one object: count, limit, truncated, elements and resolved_document.",
    {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of elements to return"),
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
              text: JSON.stringify(selectedShape(response, params.limit), null, 2),
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
