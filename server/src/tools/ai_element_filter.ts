import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { toolFailure } from "./failure.js";
import { cursorStart, pagingReply, type AddinPaging } from "../fmc/filtercursor.js";

export interface FilterIo { send?: (params: Record<string, unknown>) => Promise<unknown> }

/**
 * Tool research 1-25 (approved 28 Nov): the box is {x, y, z} in mm (the old {p0, p1} shape was ignored by the add-in,
 * which then filtered on the origin), pages carry an opaque cursor (FILTER_TOOL_SPEC 5.6), and every element on a page
 * is either a row or in skipped with a reason.
 */
export async function runAiElementFilter(args: { data: Record<string, unknown> }, io: FilterIo = {}) {
  const data = { ...(args.data ?? {}) };
  const token = typeof data.cursor === "string" ? data.cursor : "";
  const onChange = data.on_change === "continue" ? "continue" : "fail";
  delete data.cursor;
  delete data.on_change;
  const start = cursorStart(data, token);
  if (!start.ok) return toolFailure(start.message);
  if (start.cursor && typeof data.skip === "number" && data.skip > 0) return toolFailure("[FMC-FILTER-CURSOR] Pass cursor or skip, not both.");
  const params = { ...args, data: { ...data, ...(start.cursor ? { afterId: start.afterId, skip: 0 } : {}) } };
  try {
    const response = (await (io.send ? io.send(params) : withRevitConnection((revitClient) => revitClient.sendCommand("ai_element_filter", params)))) as Record<string, unknown>;
    const paging = (response?.paging ?? undefined) as AddinPaging | undefined;
    const skipped = Array.isArray(response?.skipped) ? response.skipped : [];
    if (!paging) {
      // An add-in from before this change: no cursor can be made. Say so; the offset paging in Message still works.
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...response, paging: { cursor: null, note: "This add-in build has no cursor paging yet (it installs when Revit is next closed). Use skip." } }, null, 2) }], isError: false };
    }
    const checked = pagingReply(data, start.cursor, paging, onChange);
    if (!checked.ok) return toolFailure(checked.message);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...response, paging: { ...checked.page, ids: paging.ids ?? [] }, skipped, skipped_count: skipped.length }, null, 2) }], isError: false };
  } catch (error) {
    return toolFailure(`Get element information failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const AI_ELEMENT_FILTER_SHAPE = {
      data: z.object({
    filterCategory: z
      .string()
      .optional()
      .describe("Enumeration of built-in element categories in Revit used for filtering and identifying specific element types (e.g., OST_Walls, OST_Floors, OST_GenericModel). Note that furniture elements may be classified as either OST_Furniture or OST_GenericModel categories, requiring flexible selection approaches"),
    filterElementType: z
      .string()
      .optional()
      .describe("The Revit element type name used for filtering specific elements by their class or type (e.g., 'Wall', 'Floor', 'Autodesk.Revit.DB.Wall'). Gets or sets the name of the Revit element type to be filtered."),
    filterFamilySymbolId: z
      .number()
      .optional()
      .describe("The ElementId of a specific FamilySymbol (type) in Revit used for filtering elements by their type (e.g., '123456', '789012'). Gets or sets the ElementId of the FamilySymbol to be used as a filter criterion. Use '-1' if no specific FamilySymbol filtering is needed."),
    includeTypes: z
      .boolean()
      .default(false)
      .describe("Determines whether to include element types (such as wall types, door types, etc.) in the selection results. When set to true, element types will be included; when false, they will be excluded."),
    includeInstances: z
      .boolean()
      .default(true)
      .describe("Determines whether to include element instances (such as placed walls, doors, etc.) in the selection results. When set to true, element instances will be included; when false, they will be excluded."),
    filterVisibleInCurrentView: z
      .boolean()
      .optional()
      .describe("Determines whether to only return elements that are visible in the current view. When set to true, only elements visible in the current view will be returned. Note: This filter only applies to element instances, not type elements."),
    boundingBoxMin: z
      .object({
        x: z.number().describe("X in mm"),
        y: z.number().describe("Y in mm"),
        z: z.number().describe("Z in mm"),
      })
      .strict()
      .optional()
      .describe("The box's minimum corner {x, y, z} in mm (internal coordinates). With boundingBoxMax, only instances whose bounding box intersects the box are returned. Both or neither; not with types only."),
    boundingBoxMax: z
      .object({
        x: z.number().describe("X in mm"),
        y: z.number().describe("Y in mm"),
        z: z.number().describe("Z in mm"),
      })
      .strict()
      .optional()
      .describe("The box's maximum corner {x, y, z} in mm. Each coordinate must be at least the minimum's."),
      skip: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Offset paging (older): how many matching elements to skip. Prefer cursor."),
      cursor: z
        .string()
        .optional()
        .describe("Cursor paging: the paging.cursor from the previous answer, passed back unchanged with the same filter. Pages are in element-id order; null cursor means the last page."),
      on_change: z
        .enum(["fail", "continue"])
        .optional()
        .describe("With cursor: when the model changed since the first page, fail (default, FMC-FILTER-STALE) or continue after the last id."),
      maxElements: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("The maximum number of elements to find in a single tool invocation. Default is 50. Values exceeding 50 are not recommended for performance reasons."),
  })
    .describe("Configuration parameters for the Revit element filter tool. These settings determine which elements will be selected from the Revit project based on various filtering criteria. Multiple filters can be combined to achieve precise element selection. All spatial coordinates should be provided in millimeters."),
};

export function registerAIElementFilterTool(server: McpServer) {
  server.tool(
    "ai_element_filter",
    "An intelligent Revit element querying tool designed specifically for AI assistants to retrieve detailed element information from Revit projects. This tool allows the AI to request elements matching specific criteria (such as category, type, visibility, or spatial location) and then perform further analysis on the returned data to answer complex user queries about Revit model elements. Example: When a user asks 'Find all walls taller than 5m in the project', the AI would: 1) Call this tool with parameters: {\"filterCategory\": \"OST_Walls\", \"includeInstances\": true}, 2) Receive detailed information about all wall instances in the project, 3) Process the returned data to filter walls with height > 5000mm, 4) Present the filtered results to the user with relevant details. Paging: pages are in element-id order; pass paging.cursor back unchanged with the same filter for the next page (null on the last page); a model that changed between pages is FMC-FILTER-STALE unless on_change is continue. The box is boundingBoxMin and boundingBoxMax as {x, y, z} in mm. Every element on a page is a row or is in skipped with a reason.",
    AI_ELEMENT_FILTER_SHAPE,
    async (args) => runAiElementFilter(args as { data: Record<string, unknown> }),
  );
}
