import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }], isError };
}

export const MODEL_EDIT_OPS = ["delete", "move", "set_param", "change_type", "attach", "duplicate_type", "create_roof",
  "create_railing", "create_stair", "room_separation", "opening", "shaft"] as const;

export const MODIFY_MODEL_DESCRIPTION =
  "Formcraft: edit the model like a person does in Revit (owner 26 Oct), a list of ops as ONE batch: one approval, one " +
  "Undo, all or nothing. Mix ops freely (a roof and the walls attached to it go in one batch). Lengths mm, angles degrees, " +
  "points [x, y] or [x, y, z] in mm. ids: element ids or unique ids; \"$n\" is the first element made by op n of this " +
  "batch (1-based). Ops: " +
  "delete {ids} (dependent elements go too; the answer lists every removed id) · " +
  "move {ids, vector_mm} · " +
  "set_param {ids, param, value_mm | by_mm | value_text | value, on_type?} (value_text also names a level or material, " +
  "e.g. Top Constraint \"Level 2\"; on_type changes the type, so every element of it) · " +
  "change_type {ids, type_name | type_id} · " +
  "attach {ids (walls), target (roof, floor or ceiling id), side top|base} · " +
  "duplicate_type {type (source type id), new_name, layers?: [{function: Structure|Substrate|Insulation|Finish1|Finish2|Membrane, " +
  "material, width_mm}], params?: {name: value}} · " +
  "create_roof {outline_mm (closed loop), level, type_name?, slope_deg? (every edge) or slopes_deg: [deg or null per edge, " +
  "edge i runs from point i to i+1], overhang_mm?, offset_mm?} (gable: slope on the long edges, null on the gable ends; hip: every edge) · " +
  "create_railing {path_mm, level, type_name?, host? (floor id, or a stair id to rail its treads)} · " +
  "create_stair {base_level, top_level, runs: [{start_mm, end_mm, width_mm?, risers?}], risers?, railings? (default true), railing_type?} · " +
  "room_separation {level, lines_mm: [[[x, y], [x, y]], ...]} · " +
  "opening {host (floor, ceiling or roof id), outline_mm} · " +
  "shaft {base_level, top_level, outline_mm}. " +
  "dry_run true runs it and rolls back, answering what would change: do that first for deletes. Pinned elements and " +
  "elements another user owns are refused. Use get_element_geometry first to line new work up with existing elements.";

export function registerModifyModelTool(server: McpServer) {
  server.tool(
    "modify_model",
    MODIFY_MODEL_DESCRIPTION,
    {
      ops: z.array(z.object({ op: z.enum(MODEL_EDIT_OPS) }).passthrough()).min(1).describe("The edits, run in order"),
      dry_run: z.boolean().optional().default(false).describe("Run and roll back: what would change, nothing changed"),
      why: z.string().max(300).optional().describe("One sentence for the person approving: what this batch is for"),
    },
    async (args) => {
      try {
        const r = await withRevitConnection((c) => c.sendCommand("fmc_model_edit", { ops: args.ops, dry_run: args.dry_run, ...(args.why ? { why: args.why } : {}) }));
        return reply(r, r?.applied === false && !r?.dry_run);
      } catch (e) {
        return reply(`modify_model: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "get_element_geometry",
    "Formcraft, read-only: elements' exact geometry in mm (owner 26 Oct): location line or point, level, bounding box, wall " +
      "width, height and top constraint, host, and the outline loops of floors, ceilings, roofs and rooms. Use it before " +
      "placing or editing, to line new work up exactly with what is there.",
    { ids: z.array(z.union([z.number(), z.string()])).min(1).max(200).describe("Element ids or unique ids") },
    async (args) => {
      try {
        return reply(await withRevitConnection((c) => c.sendCommand("fmc_element_geometry", { ids: args.ids })));
      } catch (e) {
        return reply(`get_element_geometry: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
