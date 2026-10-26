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
  "revision_cloud", "place_annotation", "color_fill_legend",
  "extrusion", "blend", "revolve", "sweep", "family_param", "family_type", "family_category", "reference_plane", "dimension",
  "save_family", "load_into_project",
  "column", "beam", "brace", "isolated_foundation", "wall_foundation", "foundation_slab", "structural_floor", "truss", "beam_system", "rebar", "area_reinforcement", "path_reinforcement", "fabric_area", "coping", "point_load", "line_load", "area_load", "load_case", "analytical_member", "duct", "pipe", "cable_tray", "conduit", "flex_duct", "flex_pipe", "connect", "insulation", "lining", "convert_placeholders", "wire", "space", "space_separation", "toposolid", "toposolid_subdivision", "mass_floors", "wall_by_face", "wall_sweep", "curtain_grid", "mullions", "wall_opening", "area_plan", "area", "area_boundary", "create_schedule", "revision", "radial_array", "offset", "split", "extend", "wall_join", "create_group", "place_group", "ungroup", "assembly", "parts", "displace", "paint", "remove_paint", "demolish", "path_of_travel", "energy_model", "create_material", "line_style", "line_pattern", "fill_pattern", "object_style", "project_info", "project_units", "global_param", "associate_global", "coordinates", "acquire_coordinates", "publish_coordinates", "create_workset", "set_workset", "purge", "save_selection", "copy_types", "keynote_file",
  "roof_extrusion", "fascia", "gutter", "slab_edge", "curtain_system_by_face", "building_pad", "swept_blend", "model_text", "copy_to_views", "copy_to_levels", "starting_view", "work_plane", "zone", "panel_schedule", "view_list", "reveal_hidden",
  "structural_connection", "boundary_condition", "analytical_panel", "load_combination", "multi_rebar_annotation", "rebar_coupler", "rebar_shape_bar", "rebar_cover_type", "fabric_sheet", "truss_chord", "mep_connector", "load_classification", "demand_factor", "mep_settings", "check_systems", "radial_dimension", "diameter_dimension", "align", "steel_plate", "bolts", "anchors", "weld", "shorten", "notch", "corner_fillet"] as const;

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
  "Families (in the Family Editor; new_family makes and opens one). plane: XY (default), XZ, YZ with offset_mm, or a " +
  "reference plane's name; profile points [u, v] in it (XY = [x, y], XZ = [x, z], YZ = [y, z]): " +
  "extrusion {outline_mm | loops_mm, plane?, start_mm?, end_mm, solid? (false = void), material? (a name, or a family " +
  "parameter to drive it), subcategory?} · blend {bottom_mm, top_mm, height_mm, plane?, solid?} · " +
  "revolve {outline_mm, axis_mm [[u, v], [u, v]], plane? (default XZ), start_deg?, end_deg?, solid?} · " +
  "sweep {path_mm (plan polyline), profile_mm [[u, v], ...] (u to the path's right, v up), solid?} · " +
  "family_param {name, type: Length|Text|Number|Integer|YesNo|Material|Angle|Area|Volume, instance?, group?, value?, formula?} · " +
  "family_type {name, params?: {name: value}} · family_category {category} · " +
  "reference_plane {start_mm, end_mm, name?, view?} (families and projects) · " +
  "dimension {view?, refs (reference plane names, grids, levels), line_mm, label? (a family parameter), equal?} · " +
  "save_family {path? (.rfa)} · load_into_project {project? (its title), overwrite? (default true)}. " +
  "Structure: column {level, points_mm, structural? (default true), top_level?, base_offset_mm?, top_offset_mm?, rotation_deg?, type_name?} · " +
  "beam / brace {level, start_mm, end_mm ([x, y, z], z above the level), type_name?} · isolated_foundation {level, points_mm} · " +
  "wall_foundation {ids (walls)} · foundation_slab / structural_floor {level, outline_mm | loops_mm, offset_mm?} · truss {level, start_mm, end_mm} · " +
  "beam_system {level, outline_mm, direction_edge?, spacing_mm?, type_name?} · rebar {host, curves_mm: [[[x, y, z], ...]], normal_mm?, bar_type?, count?, spacing_mm?} · " +
  "area_reinforcement / fabric_area {host, outline_mm} · path_reinforcement {host, path_mm, flip?} · coping {ids [element, cutter...], remove?} · " +
  "point_load / line_load / area_load {host? (analytical member or panel), point_mm | start_mm + end_mm | outline_mm, force_kn [fx, fy, fz], moment_knm?, load_case?} · " +
  "load_case {name, nature?, category: dead|live} · analytical_member {start_mm, end_mm}. " +
  "MEP (points [x, y, z], z above the level): duct / pipe {level, points_mm, system?, type_name?, width_mm, height_mm | diameter_mm, placeholder?, elbows? (default true)} · " +
  "cable_tray / conduit {level, points_mm, type_name?, width_mm?, height_mm? | diameter_mm?} · flex_duct / flex_pipe {level, points_mm, system?} · " +
  "connect {ids: two runs (elbow or transition) or three (tee)} · insulation / lining {ids, thickness_mm} · convert_placeholders {ids} · " +
  "wire {view, points_mm, style?: arc|chamfer} · space {level, points_mm, name?} · space_separation {level, lines_mm}. " +
  "Site and mass: toposolid {level, points_mm ([x, y, z] survey points) and/or outline_mm, type_name?} · toposolid_subdivision {host, outline_mm, material?} · " +
  "mass_floors {ids (masses), levels} · wall_by_face {host (mass), point_mm (on the face), type_name?}. " +
  "Architecture and modify: wall_sweep {ids (walls), reveal?, height_mm, side?: exterior|interior, type_name?} · " +
  "curtain_grid {wall, vertical_mm: [distances along], horizontal_mm: [heights]} · mullions {wall, type_name?} · wall_opening {wall, start_mm, end_mm} · " +
  "opening also takes vertical: true · create_view also takes kind camera {eye_mm, target_mm} · " +
  "area_plan {level, scheme?, name?} · area {view, points_mm} · area_boundary {view, lines_mm} · " +
  "create_schedule {kind?: schedule|material_takeoff|sheet_list|revision|keynote_legend|key|note_block, category?, fields: [names], sort?, itemize?, name?, family? (note_block)} · " +
  "revision {description, date?, issued_by?, issued_to?} · radial_array {ids, count, angle_deg? (default 360), center_mm?} · " +
  "offset {ids (line-based), distance_mm (to the left), copy? (default true)} · split {id, point_mm, gap_mm?} · extend {ids, target} (Trim/Extend) · " +
  "wall_join {ids, allow, end?: 0|1|both} · create_group {ids, name?} · place_group {type_name, points_mm} · ungroup {ids} · assembly {ids, name?} · " +
  "parts {ids} · displace {view, ids, vector_mm} · paint / remove_paint {id, point_mm (on the face), material} · demolish {ids, phase?} · " +
  "path_of_travel {view, start_mm, end_mm} · energy_model {}. " +
  "Settings: create_material {name, from?, color?, transparency?, class?} · line_style {name, weight?, color?, pattern?} · " +
  "line_pattern {name, segments: [{kind: dash|space|dot, length_mm}]} · fill_pattern {name, kind?: drafting|model, angle_deg, spacing_mm, crosshatch?, spacing2_mm?} · " +
  "object_style {category, subcategory?, weight?, cut_weight?, color?, pattern?, material?} · project_info {params} · " +
  "project_units {length?: Millimeters|Meters..., length_accuracy?, area?, volume?, angle?} · global_param {name, type?, value? | formula?} · " +
  "associate_global {ids, param, global} · coordinates {point_mm?, east_west_mm?, north_south_mm?, elevation_mm?, angle_deg? (true north)} · " +
  "acquire_coordinates / publish_coordinates {link} · create_workset {name} · set_workset {ids, workset} · purge {categories?, passes?} · " +
  "save_selection {name, ids} · copy_types {from (another open model), names? | categories?} (Transfer Project Standards) · keynote_file {path}. " +
  "More: roof_extrusion {plane (a named vertical reference plane), profile_mm [[u, z], ...] (open line), level, start_mm?, end_mm?, type_name?} · " +
  "fascia / gutter {host (roof; its eave edges)} · slab_edge {host (floor; its top edges)} · curtain_system_by_face {host (mass), points_mm (one per face)} · " +
  "building_pad {level, outline_mm} · swept_blend {path_mm (two points), bottom_mm, top_mm (profiles [u, v]), solid?} (families) · " +
  "model_text {text, plane?, point_mm?, depth_mm?, type_name?} (families) · model_line also takes reference_line: true · " +
  "copy_to_views {ids, from_view, views} (Paste Aligned to views) · copy_to_levels {ids, levels, from_level?} (Paste Aligned to levels) · " +
  "starting_view {view} · work_plane {view, level? | plane?, show?} · zone {level, name?, spaces?} · panel_schedule {ids (panels)} · " +
  "view_list {name?} · reveal_hidden {view, on?}. " +
  "Specialist: structural_connection {ids (members it joins), type_name?} · boundary_condition {host (analytical member or panel), " +
  "fixity: fixed|pinned|roller, kind?: point|line|area, end?: start|end} · analytical_panel {outline_mm} · load_combination {name, cases: " +
  "[{case, factor}]} · multi_rebar_annotation {view, ids (rebar), point_mm, direction_mm?, type_name?} · rebar_coupler {id (rebar), end?: 0|1, " +
  "type_name?} · rebar_shape_bar {host, shape, bar_type?, origin_mm, x_dir?, y_dir?} · rebar_cover_type {name, cover_mm} · fabric_sheet " +
  "{host, type_name?} · truss_chord {truss, target (roof or floor), chord?: top|bottom} · mep_connector {host (a form), point_mm, kind: " +
  "duct|pipe|electrical|cable_tray|conduit, system?, shape?} (families) · load_classification {name} · demand_factor {name, settings?} · " +
  "mep_settings {duct?, pipe?, electrical?, reinforcement?: {ApiPropertyName: value}} · check_systems {} (open connectors, circuits with " +
  "no panel; changes nothing) · radial_dimension / diameter_dimension {host, point_mm, view?, label?} (families) · align {refs [a, b], view?}. " +
  "Steel fabrication (needs Revit's Steel Connections add-in; mm in model coordinates): steel_plate {points_mm, normal_mm?, thickness_mm} · " +
  "bolts / anchors {ids (what they connect), corner1_mm, corner2_mm, x_dir?, y_dir?, spacing_x_mm?, spacing_y_mm?, diameter_mm?, grade?, " +
  "standard?, site?: shop|site} · weld {ids, point_mm | points_mm, thickness_mm?} · shorten {ids [beam], end: start|end, length_mm} · " +
  "notch {ids [beam], end, side?: top|bottom, length_mm, depth_mm} · corner_fillet {ids [plate], vertex, radius_mm}. " +
  "dry_run true runs it and rolls back, answering what would change: do that first for deletes. Pinned elements and " +
  "elements another user owns are refused. Use get_element_geometry first to line new work up with existing elements, " +
  "and fmc_standards for any size, height or type no brief or recipe gives (it also finds the recipe to use).";

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
    "new_family",
    "Formcraft (owner 26 Oct): a new family from a Revit family template (template: e.g. Metric Generic Model, Metric " +
      "Furniture, Metric Door; or a .rft path), saved at path (.rfa) and opened in the Family Editor. Then build it with " +
      "modify_model's family ops, save_family, and load_into_project.",
    {
      template: z.string().optional().default("Metric Generic Model"),
      path: z.string().describe("Where to save the new family, ending .rfa (a project's 01_WIP or the kit's staging)"),
      overwrite: z.boolean().optional().default(false),
    },
    async (args) => {
      try {
        return reply(await withRevitConnection((c) => c.sendCommand("fmc_family_new", args)));
      } catch (e) {
        return reply(`new_family: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "revit_file",
    "Formcraft (owner 26 Oct): what Revit does with files, outside an edit batch. action: save, save_as {path, overwrite?, " +
      "as_central?}, open {path}, close {title, save?} (not the active model), export {format: dwg|dxf|dgn|sat|pdf|ifc|nwc|" +
      "fbx|dwf|gbxml|image|schedule, folder, name?, views? (names, sheet numbers or ids; default the active view), combine? " +
      "(pdf), pixels? (image)}, link_cad / import_cad {path, view?, this_view_only?}, link_image / import_image / link_pdf " +
      "{path, view?, point_mm?, page? (pdf)}, link_revit {path, placement?: shared|origin}, load_family {path}, point_cloud " +
      "{path}, sync {comment?, relinquish? (default true), compact?}, reload_latest, relinquish, open_ifc {path}, export_family " +
      "{family, path (.rfa), overwrite?} (Save As Library Family). Sync and relinquish always " +
      "wait for a person's approval, even with auto-approve.",
    {
      action: z.enum(["save", "save_as", "open", "close", "export", "link_cad", "import_cad", "link_image", "import_image", "link_pdf",
        "link_revit", "load_family", "point_cloud", "sync", "reload_latest", "relinquish", "open_ifc", "export_family"]),
      family: z.string().optional().describe("export_family: the family to save out of the project"),
      path: z.string().optional(), title: z.string().optional(), save: z.boolean().optional(), overwrite: z.boolean().optional(),
      as_central: z.boolean().optional(), format: z.string().optional(), folder: z.string().optional(), name: z.string().optional(),
      views: z.array(z.union([z.string(), z.number()])).optional(), combine: z.boolean().optional(), pixels: z.number().int().optional(),
      view: z.string().optional(), this_view_only: z.boolean().optional(), point_mm: z.array(z.number()).optional(),
      page: z.number().int().optional(), placement: z.enum(["shared", "origin"]).optional(), comment: z.string().optional(),
      relinquish: z.boolean().optional(), compact: z.boolean().optional(), engine: z.string().optional(),
    },
    async (args) => {
      try {
        return reply(await withRevitConnection((c) => c.sendCommand("fmc_revit_file", args)));
      } catch (e) {
        return reply(`revit_file: ${e instanceof Error ? e.message : String(e)}`, true);
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
