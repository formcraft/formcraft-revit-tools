import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }], isError };
}

export const MODEL_EDIT_OPS = ["copy", "rotate", "mirror", "join", "unjoin", "switch_join", "cut", "uncut", "pin", "unpin", "delete", "move", "set_param", "change_type", "attach", "duplicate_type", "create_roof",
  "create_railing", "create_stair", "room_separation", "opening", "shaft",
  "create_view", "duplicate_view", "set_view", "override", "hide", "unhide", "create_filter", "create_template", "apply_template",
  "create_sheet", "place_view", "open_view",
  "detail_line", "model_line", "filled_region", "masking_region", "text", "replace_text", "tag", "spot_elevation", "spot_coordinate",
  "revision_cloud", "place_annotation", "color_fill_legend"] as const;

export const MODIFY_MODEL_DESCRIPTION =
  "Formcraft: edit the model like a person does in Revit (owner 26 Oct), a list of ops as ONE batch: one approval, one " +
  "Undo, all or nothing. Mix ops freely (a roof and the walls attached to it go in one batch). Lengths mm, angles degrees, " +
  "points [x, y] or [x, y, z] in mm. ids: element ids or unique ids; \"$n\" is the first element made by op n of this " +
  "batch (1-based). Ops: " +
  "delete {ids} (dependent elements go too; the answer lists every removed id) · " +
  "move {ids, vector_mm} · " +
  "copy {ids, vector_mm, count? (more than 1 = an array, each copy one vector further)} · " +
  "rotate {ids, angle_deg (anticlockwise), center_mm? (default the elements' centre), copy?} · " +
  "mirror {ids, line_mm: [[x, y], [x, y]] (the axis), copy? (default true keeps the originals)} · " +
  "join / unjoin / switch_join {ids: [a, b, ...] (a with each other)} · cut / uncut {ids: [cutting, cut, ...]} · " +
  "pin / unpin {ids} · " +
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
  "Views and sheets (a view is its id, name, sheet number or \"$n\"): " +
  "create_view {kind: floor_plan|ceiling_plan|structural_plan|section|elevation|3d|drafting|callout, name?, type_name?, " +
  "level (plans), line_mm + depth_mm? + bottom_mm? + top_mm? (section: cut line in plan, it looks to the line's left), " +
  "point_mm + face 0-3 + plan? (elevation; the answer gives the direction), parent + box_mm (callout), section_box_mm? (3d), " +
  "and any set_view field} · " +
  "duplicate_view {view, mode: duplicate|with_detailing|as_dependent, name?} · " +
  "set_view {view, rename?, scale?, detail_level: Coarse|Medium|Fine, discipline?, template (name or none), crop_mm " +
  "[[x, y], [x, y]], crop_visible?, view_range_mm {top, cut, bottom, depth} (offsets from the level), section_box_mm?, params?} · " +
  "override {view, ids | categories (Walls or OST_Walls) | filter, color [r, g, b], fill? (default true), line_weight?, " +
  "transparency?, halftone?, visible? (filters)} · " +
  "hide / unhide {view, ids?, categories?} · " +
  "create_filter {name, categories, rules?: [{param, op: equals|not_equals|contains|begins_with|greater|less, value | value_mm}]} · " +
  "create_template {view, name} · apply_template {template, views, once? (apply its settings without linking)} · " +
  "create_sheet {number, name, title_block?} · place_view {sheet, view, point_mm? (on the sheet; default its centre)} · " +
  "open_view {view} (shown when the batch is done). " +
  "Annotation (points in model mm; on a sheet or drafting view, in its own): " +
  "detail_line {view, points_mm (a polyline), closed?, line_style?} · model_line {points_mm, level?, line_style?} · " +
  "filled_region {view, outline_mm | loops_mm (first outside, rest holes), type_name?} · masking_region {view, outline_mm} · " +
  "text {view, point_mm, text, type_name?, width_mm? (on paper), align?: Left|Center|Right} · " +
  "replace_text {find, replace, views?} · " +
  "tag {view, ids, tag_type? (a keynote, material or any tag type name), mode?: category|multi|material, leader?, " +
  "offset_mm?, orientation?} (rooms, spaces and areas get their own tags) · " +
  "spot_elevation / spot_coordinate {view, id (floor, roof, toposolid...), point_mm, leader?} · " +
  "revision_cloud {view, outline_mm, revision? (description or number; default the latest)} · " +
  "place_annotation {view, type_name (detail item, symbol or generic annotation), point_mm, rotation_deg?} · " +
  "color_fill_legend {view, category? (default Rooms), scheme?, point_mm}. " +
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
    "run_revit_command",
    "Formcraft (owner 26 Oct): start any of Revit's 568 built-in commands by name, the way a person clicks the ribbon, " +
      "optionally selecting elements first (select_ids). Use it for what no other tool does: Revit runs the command after " +
      "this answers, and a command that needs picks or a dialog waits for the person, so tell them what to click. action " +
      "list: every command name and whether Revit can start it now. Prefer modify_model and the other tools when they " +
      "cover the job: they run fully and report back.",
    {
      action: z.enum(["run", "list"]).optional().default("run"),
      command: z.string().optional().describe("run: the command's name, e.g. RoofByExtrusion, MirrorPickAxis, Ramp, VisibilityOrGraphics"),
      select_ids: z.array(z.union([z.number(), z.string()])).max(500).optional().describe("run: elements to select first"),
    },
    async (args) => {
      try {
        if (args.action === "list") return reply(await withRevitConnection((c) => c.sendCommand("fmc_list_commands", {})));
        if (!args.command) return reply("run_revit_command: give command (action list gives the names)", true);
        return reply(await withRevitConnection((c) => c.sendCommand("fmc_post_command", { command: args.command, ...(args.select_ids ? { select_ids: args.select_ids } : {}) })));
      } catch (e) {
        return reply(`run_revit_command: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "get_design_options",
    "Formcraft, read-only (owner 26 Oct): the model's design option sets, their options, which is primary and which is " +
      "active. Revit's API can't create options or move elements into one; a person does that in Revit (Manage › Design " +
      "Options). Elements AI makes go into the option active in Revit, so ask the person to make the right one active first.",
    {},
    async () => {
      try {
        return reply(await withRevitConnection((c) => c.sendCommand("fmc_design_options", {})));
      } catch (e) {
        return reply(`get_design_options: ${e instanceof Error ? e.message : String(e)}`, true);
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
