import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { executeKeynoteBatch } from "../fmc/keynote.js";
import { decodeKeynoteFile, keynoteTableWarnings } from "../fmc/library.js";
import { executePropertyLineBatch } from "../fmc/propertyline.js";
import { documentTarget } from "../fmc/target.js";
import { touchedIds, viewImage } from "./see_view.js";

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }], isError };
}

/** keynote_file loads the table in Revit. An LF-only file comes back as one entry; say so on the answer. */
function attachKeynoteFileWarnings(ops: Array<{ op?: string; path?: unknown }>, result: any): void {
  if (!result || typeof result !== "object") return;
  const seen = new Set<string>();
  const rows = Array.isArray(result.ops) ? result.ops : [];
  for (const row of rows) if (Array.isArray(row?.warnings)) for (const w of row.warnings) seen.add(String(w));
  const notes: string[] = [];
  for (const op of ops) {
    if (op?.op !== "keynote_file" || typeof op.path !== "string" || !op.path.trim()) continue;
    let text = "";
    try { text = decodeKeynoteFile(fs.readFileSync(op.path)); }
    catch { continue; }
    const row = rows.find((item: any) => item?.kind === "keynote_file" && item?.keynotes === op.path);
    const loaded = typeof row?.loaded === "number" && row.loaded >= 0 ? row.loaded : undefined;
    for (const warning of keynoteTableWarnings(text, loaded)) if (!seen.has(warning)) { seen.add(warning); notes.push(warning); }
  }
  if (!notes.length) return;
  const prev = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  result.warnings = [...prev, ...notes];
}

export const MODEL_EDIT_OPS = ["copy", "rotate", "mirror", "join", "unjoin", "switch_join", "cut", "uncut", "pin", "unpin", "delete", "move", "set_param", "change_type", "attach", "duplicate_type", "create_roof",
  "create_railing", "create_stair", "room_separation", "opening", "shaft",
  "create_view", "duplicate_view", "set_view", "override", "hide", "unhide", "create_filter", "create_template", "apply_template",
  "create_sheet", "place_view", "open_view",
  "detail_line", "model_line", "property_line", "property_line_verify", "property_line_tag", "filled_region", "masking_region", "text", "replace_text", "tag", "keynote_legend", "place_schedule", "keynote_audit", "keynote_retag", "keynote_clone", "spot_elevation", "spot_coordinate",
  "revision_cloud", "place_annotation", "color_fill_legend",
  "extrusion", "blend", "revolve", "sweep", "family_param", "family_type", "family_category", "reference_plane", "dimension",
  "save_family", "load_into_project",
  "column", "beam", "brace", "isolated_foundation", "wall_foundation", "foundation_slab", "structural_floor", "truss", "beam_system", "rebar", "area_reinforcement", "path_reinforcement", "fabric_area", "coping", "point_load", "line_load", "area_load", "load_case", "analytical_member", "duct", "pipe", "cable_tray", "conduit", "flex_duct", "flex_pipe", "connect", "insulation", "lining", "convert_placeholders", "wire", "space", "space_separation", "toposolid", "toposolid_subdivision", "mass_floors", "wall_by_face", "wall_sweep", "curtain_grid", "mullions", "wall_opening", "area_plan", "area", "area_boundary", "create_schedule", "revision", "radial_array", "offset", "split", "extend", "wall_join", "create_group", "place_group", "ungroup", "assembly", "parts", "displace", "paint", "remove_paint", "demolish", "path_of_travel", "energy_model", "create_material", "line_style", "line_pattern", "fill_pattern", "object_style", "project_info", "project_units", "global_param", "associate_global", "coordinates", "acquire_coordinates", "publish_coordinates", "create_workset", "set_workset", "purge", "save_selection", "copy_types", "keynote_file",
  "roof_extrusion", "fascia", "gutter", "slab_edge", "curtain_system_by_face", "building_pad", "swept_blend", "model_text", "copy_to_views", "copy_to_levels", "starting_view", "work_plane", "zone", "panel_schedule", "view_list", "reveal_hidden",
  "structural_connection", "boundary_condition", "analytical_panel", "load_combination", "multi_rebar_annotation", "rebar_coupler", "rebar_shape_bar", "rebar_cover_type", "fabric_sheet", "truss_chord", "mep_connector", "load_classification", "demand_factor", "mep_settings", "check_systems", "radial_dimension", "diameter_dimension", "align", "steel_plate", "bolts", "anchors", "weld", "shorten", "notch", "corner_fillet",
  "create_wall", "create_floor", "create_ceiling", "create_room", "place_family", "rehost", "edit_sketch", "wall_profile",
  "section_box", "box_views", "site_floor", "for_each", "display_mode"] as const;

export const MODIFY_MODEL_DESCRIPTION =
  "Formcraft: edit the model like a person does in Revit (owner 26 Oct), a list of ops as ONE batch: one approval, one " +
  "Undo, all or nothing. Mix ops freely (a roof and the walls attached to it go in one batch). Lengths mm, angles degrees, " +
  "points [x, y] or [x, y, z] in mm. ids: element ids or unique ids; \"$n\" is the first element made by op n of this " +
  "batch (1-based). " +
  "Depth on every op (owner 27 Oct): select {query} in place of (or as well as) ids picks the elements when the op runs, " +
  "so it sees what earlier ops made; a {select: {query}} (or the query itself) in place of one id (host, target, id, " +
  "along...) must match one element (or first: true). The query, all combined: ids, category (or a list), level, " +
  "type_name, family, comment, mark, workset, phase, view (visible in it; \"active\"), room (inside it), box (a BOX, " +
  "inside? true), box_mm, near {id | point_mm, within_mm}, hosted_by, host_of, param {name, is: equals|contains|starts|" +
  "gt|lt|empty|not_empty, value (lengths in mm)} or a list, exclude (ids), not {query}, types true (types, not " +
  "instances), limit (default 5000; more is refused). for_each {per: room|level|element|view|sheet|grid_intersection|" +
  "point, items? | select? | level? (rooms) | view_type? | name_contains?, ops: [...]} runs the ops once per item with " +
  "its values filled in: \"{id}\", \"{name}\", \"{number}\", \"{level}\", \"{next_level}\", \"{center_mm}\", " +
  "\"{min_mm}\", \"{max_mm}\", \"{outline_mm}\" (a room's boundary), \"{start_mm}\", \"{end_mm}\", " +
  "\"{length_mm}\", \"{elevation_mm}\", \"{host}\", \"{type_id}\", \"{index}\" (a whole \"{x}\" is the value itself; " +
  "inside text it is text); \"@k\" is op k of the same pass. Up to 500 items, 3000 ops. Ops: " +
  "delete {ids} (dependent elements go too; the answer lists every removed id) · " +
  "move {ids, vector_mm} · " +
  "copy {ids, vector_mm, count? (more than 1 = an array, each copy one vector further)} · " +
  "rotate {ids, angle_deg (anticlockwise), center_mm? (default the elements' centre), copy?} · " +
  "mirror {ids, line_mm: [[x, y], [x, y]] (the axis), copy? (default true keeps the originals), keep_side? (default true: a mirrored " +
  "door or window faces the same side of its wall as the original)} · " +
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
  "create_stair {base_level, top_level, runs: [{start_mm, end_mm (its direction) | direction_deg, width_mm?, risers?}], risers? (default the " +
  "height at 175 mm max), riser_max_mm?, railings? (default true; skipped when the stair type makes its own), railing_type?} (each run's " +
  "length is worked out from its risers and the type's tread) · " +
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
  "property_line {from_ids (model or detail line ids) | points_mm, closed? (default true), level?, name?, keep_source? (default true), " +
  "dry_run? (default true on this op, even when the batch dry_run is false)} · property_line_verify {known_ids?, delete_source_ids?} · " +
  "property_line_tag {view, ids | select, tag_type?, leader?}. Revit 2025 and 2026 have no PropertyLine.Create (it arrives in 2027; " +
  "calling it is CS0117). points_mm returns FMC-NO-API-PROPERTYLINE and is not sent to Revit. from_ids with dry_run false selects those " +
  "lines and posts the Property Line command, then returns FMC-NEEDS-HUMAN: choose Create by sketching, then Pick Lines, and finish. " +
  "That command cannot be awaited and does not create the line by itself. Source lines are kept; keep_source false does not delete them " +
  "until property_line_verify finds a new property line and is given delete_source_ids. The kit has no property-line tag family. " +
  "These ops are their own batch, a server hot-swap; the add-in is unchanged. · " +
  "filled_region {view, outline_mm | loops_mm (first outside, rest holes), type_name?} · masking_region {view, outline_mm} · " +
  "text {view, point_mm, text, type_name?, width_mm? (on paper), align?: Left|Center|Right} · " +
  "replace_text {find, replace, views?} · " +
  "tag {view, ids | select, tag_type?, mode?: category|multi|material|keynote_element|keynote_material|keynote_user, leader? " +
  "(default true for a keynote mode), one_per_key? (default true for a keynote mode: one tag per distinct key already in the view " +
  "or made by this op), key? (the keynote code, required for keynote_user), offset_mm?, orientation?} " +
  "keynote_element, keynote_material and keynote_user do not set Key Source. The API cannot link a keynote tag: a probe tag is rolled back, " +
  "and if TagText and Keynote Text are empty the answer is FMC-NO-API-KEYNOTE-LINK and nothing is placed. Tag them with Annotate > Keynote > Element, " +
  "or Tag All Not Tagged with Keynote Tags, per view. When tag_type is omitted, a loaded FMC_TAG_Keynote_v2 type Key Value is used; otherwise the model's " +
  "default keynote tag (M_Keynote Tag). An empty keynote is skipped_empty_keynote. A Keynote Text type whose key is missing from the table is " +
  "key_not_in_table and is not placed. A blank TagText is deleted, not kept. shown counts only tags whose TagText was not empty. " +
  "keynote_retag {views | view, ui_assist? (default true), ids?} with dry_run false activates the first view, selects nothing, and posts Tag All Not Tagged " +
  "(FMC-NEEDS-HUMAN) when that command exists. The answer lists the view queue. keynote_clone {seed, ids, dry_run? (default true)} copies one linked tag " +
  "and repoints it; a blank copy is rolled back. keynote_audit lists blank keynote tags by view and linked tags (TagText not empty: id, view, host, key, Key Source), with a seed for keynote_clone per tag type. If a type has no linked tag, seed is null and the hint is to make one via keynote_retag. It deletes nothing. " +
  "These ops run through the code bridge (a server hot-swap) and must be their own batch. category, multi and material stay on the add-in; a keynote tag " +
  "type on that path is refused. Rooms, spaces and areas still get their own tags. · " +
  "keynote_legend {name?, filtered_by_sheet?} creates a keynote legend schedule. It is not a keynote tag: a for_each of keynote_legend runs on the add-in. · " +
  "place_schedule {sheet, schedule, point_mm} places a schedule or legend on a sheet; point_mm is on the sheet. It is not a keynote tag: a for_each of place_schedule runs on the add-in. · " +
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
  "connect {ids: two runs (elbow or transition) or three (tee), or a pipe and a plumbing fixture. A fixture uses its nearest unconnected " +
  "piping connector (MEPModel.ConnectorManager): sanitary for waste and soil, domestic hot or cold for supply. system?: sanitary|waste|soil|supply|domestic hot|domestic cold. " +
  "Until this add-in is installed, use fmc_connect_fixture, which does the same join from the server.} · insulation / lining {ids, thickness_mm} · convert_placeholders {ids} · " +
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
  "Section boxes (owner 27 Oct; use them freely to focus, detail and narrow down): section_box {view | views (3D views get a " +
  "section box; plans and sections get their crop, view_range true / far_clip true too; \"active\" is the open view; none: a new " +
  "3D view, name?), BOX, from? (iso, iso_nw, iso_ne, iso_sw, front, back, left, right, top), show?, open?, off? (true turns it off), perspective? (new view)} · " +
  "box_views {per: room|level|element, items? (default all rooms or levels), prefix?, BOX modifiers, from?} (one boxed 3D view each; " +
  "a view of the same name is re-boxed). BOX: where it starts, combined: ids, category (+ level: on that level), room (id, number or " +
  "name), box_mm [[x, y, z], [x, y, z]], from_view (copy another view's box), cut_line_mm [[x, y], [x, y]] + keep left|right + " +
  "depth_mm? (a 3D section along a line), level (+ to_level | height_mm | cut_mm: a storey slice, or a plan-like cut); none: the " +
  "view's own box, else the building. Then margin_mm (number or [x, y, z]; default 300 round elements, 200 round a room), grow_mm " +
  "{top, bottom, left|west, right|east, front|south, back|north} (negative shrinks), top_mm / bottom_mm (absolute), slice {at_mm, keep: " +
  "below|above}, move_mm, along (an element id: the box turns to it) or angle_deg. " +
  "site_floor {level, outline_mm | loops_mm, type_name?, topo? (default the toposolid under it), at?: centre|highest|lowest|average " +
  "(where its top meets the ground), offset_mm?, cut? (default true: it excavates the toposolid)}. " +
  "display_mode {mode: navigate|render, views? (ids, names, \"active\"; default every 3D view), style? (shaded, shaded_edges, " +
  "consistent, realistic, realistic_edges, hidden), detail? coarse|medium|fine, templates? (true: change the template of a " +
  "templated view)} (owner 27 Oct, a slow model: navigate = Shaded and model surface patterns hidden, quick to orbit; render = " +
  "Realistic, patterns back. Materials aren't touched; see material_report first). " +
  "Core: create_wall {level, start_mm + end_mm | points_mm, type_name?, height_mm? | top_level?, base_offset_mm?, top_offset_mm?, structural?, flip?} · " +
  "create_floor / create_ceiling {level, outline_mm | loops_mm (first the outside, then holes), type_name?, offset_mm?, structural?} · " +
  "create_room {level, points_mm, name?, number?} · place_family {type_name | type_id, points_mm, level?, host? (wall id or \"$n\" from this batch), " +
  "sill_mm?, offset_mm?, rotation_deg?, flip_facing?, flip_hand?} · rehost {ids, level} (keeps each in place: its offset changes) · " +
  "edit_sketch {id (floor, ceiling or roof), outline_mm | loops_mm} (Edit Boundary) · wall_profile {id (wall), profile_mm | loops_mm: [[u, v]] " +
  "(u along the wall from its start, v up from its base: an arch, a gable top)} (Edit Profile). move reports not_moved_in_z for " +
  "level-hosted elements. create_roof overhang_mm offsets the outline and drops the base so the roof still meets the walls. " +
  "dry_run needs no approval. " +
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
  "and fmc_standards for any size, height or type no brief or recipe gives (it also finds the recipe to use). " +
  "A picture is not taken unless picture is true (snapshot true is the same switch). Elements with no extent are not pictured.";

/** Ops whose result isn't something to look at in 3D (views, sheets, settings, files). */
const NO_PICTURE = new Set(["delete", "set_param", "create_view", "duplicate_view", "set_view", "override", "hide", "unhide", "create_filter",
  "create_template", "apply_template", "create_sheet", "place_view", "open_view", "text", "replace_text", "tag", "keynote_legend", "place_schedule", "keynote_audit", "keynote_retag", "keynote_clone", "revision", "create_schedule",
  "save_family", "load_into_project", "family_param", "family_type", "family_category", "create_material", "line_style", "line_pattern",
  "property_line", "property_line_verify", "property_line_tag",
  "fill_pattern", "object_style", "project_info", "project_units", "global_param", "associate_global", "coordinates", "acquire_coordinates",
  "publish_coordinates", "create_workset", "set_workset", "purge", "save_selection", "copy_types", "keynote_file", "starting_view",
  "work_plane", "zone", "panel_schedule", "view_list", "reveal_hidden", "section_box", "box_views", "display_mode", "load_case", "load_combination", "load_classification",
  "demand_factor", "mep_settings", "check_systems", "rebar_cover_type", "area_plan", "energy_model"]);

/** Elements whose model bounding box is empty (grids, levels, reference planes, tags). A close-up cannot be framed. */
const NO_EXTENT = new Set(["reference_plane", "dimension", "radial_dimension", "diameter_dimension", "align",
  "spot_elevation", "spot_coordinate", "revision_cloud", "text", "replace_text", "tag", "keynote_legend", "place_schedule", "keynote_audit", "keynote_retag", "keynote_clone", "place_annotation",
  "color_fill_legend", "detail_line", "multi_rebar_annotation"]);

/** A picture is taken only when the caller asks. Default off. */
export function wantsAfterPicture(args: { picture?: boolean; snapshot?: boolean }): boolean {
  return args.picture === true || args.snapshot === true;
}

/** True when at least one op can leave an element with a model extent. Datums and annotations cannot. */
export function batchHasExtent(ops: Array<{ op?: string }>): boolean {
  return ops.some((op) => {
    const name = String(op?.op ?? "");
    return !NO_PICTURE.has(name) && !NO_EXTENT.has(name);
  });
}

export const UNDO_AI_BATCH_DESCRIPTION =
  "Formcraft (owner 27 Oct): take back the AI's own work with Revit's Undo. With no action (the default) it only reads: " +
  "action status is Revit's undo list as the AI sees it (the AI's batches and a person's changes). Nothing is undone unless " +
  "you pass action undo (or redo) yourself. action undo: batch_id (modify_model answers it; scripts answer undo_id): that " +
  "batch and any AI batches made after it; without it, the last count batches (default 1). It never undoes a person's work: " +
  "if a person changed the model after the batch, it refuses and says what is on top. redo: the batch the last undo took " +
  "back. dry_run true with undo (or redo): the plan, i.e. the batches it would take back, with the same refusals (a person's " +
  "work on top), and nothing posted; call it before an undo. The model must be the active window in Revit; a sync with " +
  "central or closing the model clears Revit's undo list.";

/** undo_ai_batch's inputs. UB-1: action defaults to status (a read); undo and redo must be asked for by name. */
export const UNDO_AI_BATCH_SHAPE = {
  action: z.enum(["status", "undo", "redo"]).optional().default("status")
    .describe("status (default): read the undo list, nothing changes. undo / redo: post Revit's Undo / Redo; only when a person asked for it."),
  batch_id: z.string().max(40).optional(),
  count: z.number().int().min(1).max(20).optional(),
  dry_run: z.boolean().optional()
    .describe("UB-2: with action undo or redo, return what would be taken back (and what would block it) without posting anything."),
};

export type UndoAiBatchArgs = { action?: "status" | "undo" | "redo"; batch_id?: string; count?: number; dry_run?: boolean };

/**
 * The first socket call undo_ai_batch makes. A missing action is a status read (UB-1): only an explicit
 * action "undo" or "redo" reaches fmc_undo (a write).
 */
export function undoAiBatchCall(args: UndoAiBatchArgs): { command: "fmc_undo" | "fmc_undo_status"; params: Record<string, unknown> } {
  const action = args?.action ?? "status";
  if (action !== "undo" && action !== "redo") return { command: "fmc_undo_status", params: {} };
  // UB-2: a dry run is a read (fmc_undo_status, never fmc_undo), so it needs no lease and posts nothing
  if (args.dry_run === true) {
    if (action === "redo") return { command: "fmc_undo_status", params: { action: "redo_plan" } };
    return {
      command: "fmc_undo_status",
      params: { action: "plan", ...(args.batch_id ? { batch_id: args.batch_id } : {}), ...(args.count ? { count: args.count } : {}) },
    };
  }
  return {
    command: "fmc_undo",
    params: { action, ...(args.batch_id ? { batch_id: args.batch_id } : {}), ...(args.count ? { count: args.count } : {}) },
  };
}

/**
 * UB-2: an add-in from before the dry run answers a plan request with plain status. Say so rather than let it pass for a plan.
 */
export function undoDryRunReply(params: Record<string, unknown>, result: any): [unknown, boolean] {
  const wanted = params?.action === "plan" || params?.action === "redo_plan";
  if (!wanted || result?.dry_run === true) return [result, false];
  return [{
    dry_run: false, posted: false,
    error: "[FMC-UNDO-DRYRUN-UNSUPPORTED] The installed add-in has no undo dry run; nothing was undone. Here is the undo list instead.",
    status: result,
  }, true];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerModifyModelTool(server: McpServer) {
  server.tool(
    "undo_ai_batch",
    UNDO_AI_BATCH_DESCRIPTION,
    UNDO_AI_BATCH_SHAPE,
    async (args) => {
      try {
        const call = undoAiBatchCall(args);
        if (call.command === "fmc_undo_status") {
          const s = await withRevitConnection((c) => c.sendCommand(call.command, call.params));
          return reply(...undoDryRunReply(call.params, s));
        }
        const r = await withRevitConnection((c) => c.sendCommand(call.command, call.params));
        if (!r?.posted) return reply(r, !r?.queued && !r?.approval);
        // Revit runs each Undo once it is idle; the add-in posts the next after Revit reports the last
        let s: any;
        for (let i = 0; i < 60; i++) {
          await sleep(500);
          s = await withRevitConnection((c) => c.sendCommand("fmc_undo_status", {}));
          if (!s?.undo_running) break;
        }
        const top = s?.undo_list?.[0];
        return reply({
          asked: r.undoing ?? r.redoing, done: s?.done, stopped: s?.stopped ?? (s?.undo_running ? "still running: check with action status" : undefined),
          now_on_top: top ? `${top.kind === "ai" ? "AI" : "a person"}: ${top.label}` : "nothing",
          ...(r?.document ? { document: r.document } : {}),
        }, Boolean(s?.stopped));
      } catch (e) {
        return reply(`undo_ai_batch: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "modify_model",
    MODIFY_MODEL_DESCRIPTION,
    {
      ops: z.array(z.object({ op: z.enum(MODEL_EDIT_OPS) }).passthrough()).min(1).describe("The edits, run in order"),
      dry_run: z.boolean().optional().default(false).describe("Run and roll back: what would change, nothing changed"),
      why: z.string().max(1000).optional().describe("A sentence or two (up to 1000 characters) for the person approving: what this batch is for"),
      picture: z.boolean().optional().default(false).describe("Take a picture of the changed elements and return it with the answer. Default false. A picture is for a failed check or a founder's sign-off, not after every batch."),
      snapshot: z.boolean().optional().describe("Same switch as picture. Default off. Nothing is pictured unless picture or snapshot is true."),
    },
    async (args) => {
      try {
        const keynote = await executeKeynoteBatch(args.ops, args.dry_run, documentTarget.getStore(),
          (command, params) => withRevitConnection((c) => c.sendCommand(command, params)));
        if (keynote) return reply(keynote.body, keynote.isError);
        const propertyLine = await executePropertyLineBatch(args.ops, args.dry_run, documentTarget.getStore(),
          (command, params) => withRevitConnection((c) => c.sendCommand(command, params)));
        if (propertyLine) return reply(propertyLine.body, propertyLine.isError);
        const r = await withRevitConnection((c) => c.sendCommand("fmc_model_edit", { ops: args.ops, dry_run: args.dry_run, ...(args.why ? { why: args.why } : {}) }));
        attachKeynoteFileWarnings(args.ops, r);
        const out = reply(r, r?.applied === false && !r?.dry_run) as { content: any[]; isError: boolean };
        // Owner 26 Oct: the AI sees what it did, so it can check its own work like a person glancing at the screen
        const ids = r?.applied ? touchedIds(args.ops as any[], r).filter((id) => !(r.ops ?? []).some((x: any) => (x.removed_ids ?? []).includes(id))) : [];
        if (wantsAfterPicture(args) && ids.length && batchHasExtent(args.ops)) {
          try { const { image } = await viewImage({ ids, size: 900 }); if (image) out.content.push(image); }
          catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (!/no extent/i.test(message)) out.content.push({ type: "text", text: `(no picture: ${message})` });
          }
        }
        return out;
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
    "Formcraft (owner 26 Oct): what Revit does with files, outside an edit batch. To save a project, use fmc_save_project " +
      "(it checks the title and the path and refuses a family). action save here does not. action: save, save_as {path, overwrite?, " +
      "as_central?}, open {path}, close {title, save?} (not the active model), export {format: dwg|dxf|dgn|sat|pdf|ifc|nwc|" +
      "fbx|dwf|gbxml|image|schedule, folder, name?, views? (names, sheet numbers or ids; default the active view), combine? " +
      "(pdf), pixels? (image)}, link_cad / import_cad {path, view?, this_view_only?}, link_image / import_image / link_pdf " +
      "{path, view?, point_mm?, page? (pdf)}, link_revit {path, placement?: shared|origin}, load_family {path, overwrite? (default " +
      "true: replaces a loaded family, its parameters too)}, point_cloud " +
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
