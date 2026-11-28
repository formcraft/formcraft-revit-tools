#!/usr/bin/env node
// Night test (owner 26 Oct): every modify_model op and the new tools, unattended, on a sandbox model only.
// Pass "dry": each case is a modify_model dry run (it runs in Revit, then rolls back: the sandbox doesn't change).
// Pass "real": the same cases for real, then model_check, a picture of each, and a save (sandbox only).
// Pass "family": a scratch family is made, built with curves and parameters, and saved beside the sandbox.
// Usage: node scripts/night-test.mjs --model OGL_TEST_Sandbox --out <folder> [--pass dry|real|family|all]
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg("model", "OGL_TEST_Sandbox");
const OUT = arg("out", path.resolve("night-test-out"));
const PASS = arg("pass", "all");
const BUILD = arg("build", "C:/Users/USER/mcp/revit-fmc/build");
const SANDBOX = arg("sandbox", "");  // the sandbox .rvt, to come back to after the family pass
if (/MainHouse|OGALA/i.test(MODEL)) { console.error("refusing: the night test runs on a sandbox model only"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const url = (p) => "file:///" + path.join(BUILD, p).replace(/\\/g, "/");
const { withRevitConnection } = await import(url("utils/ConnectionManager.js"));
const { revitTarget } = await import(url("fmc/target.js"));

const send = (cmd, params = {}, ms = 600000) => revitTarget.run(MODEL, () => withRevitConnection((c) => c.sendCommand(cmd, params, ms)));
const results = [];
const log = (line) => { fs.appendFileSync(path.join(OUT, "night.log"), `${new Date().toISOString()} ${line}\n`); console.log(line); };

async function test(group, name, cmd, params, judge) {
  const t0 = Date.now();
  let ok = false, detail = "", res = null;
  try {
    res = await send(cmd, params);
    const failed = res && res.applied === false && !res.dry_run;
    ok = judge ? judge(res) : !failed;
    detail = failed ? `op ${res.failed_op} (${res.kind}): ${res.reason}` : (res?.new_warnings ? `${res.new_warnings.length} new warnings: ${res.new_warnings.map((w) => w.text).slice(0, 2).join("; ")}` : "");
  } catch (e) { detail = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 400); }
  const r = { group, name, ok, ms: Date.now() - t0, detail };
  results.push(r);
  log(`${ok ? "PASS" : "FAIL"} ${group} · ${name} (${r.ms} ms)${detail ? " — " + detail : ""}`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
  return res;
}
const edit = (group, name, ops, dry) => test(group, name, "fmc_model_edit", { ops, dry_run: dry, why: `night test: ${name}` });

// ---- what the sandbox has ----
const info = await send("fmc_document_info", {});
const levels = (info?.active?.levels ?? []).map((l) => l.name);
const GF = levels.find((l) => /^GF/.test(l)) ?? levels[0], FF = levels.find((l) => /^FF/.test(l)) ?? levels[1], ROOF = levels.find((l) => /^Roof/.test(l)) ?? levels[levels.length - 1];
const first = async (category) => (await send("fmc_select_by", { category, limit: 1 }))?.ids?.[0];
const types = async (c) => { const r = await send("get_available_family_types", { categoryList: [c] }); return Array.isArray(r) ? r : r?.response ?? r?.Response ?? []; };
const someWalls = (await send("fmc_select_by", { category: "Walls", limit: 2 }))?.ids ?? [];
const spareWall = someWalls[1] ?? someWalls[0];
const wall = await first("Walls"), floor = await first("Floors"), roof = await first("Roofs"), topo = await first("Toposolid");
const wallTypes = await types("OST_Walls"), floorTypes = await types("OST_Floors"), roofTypes = await types("OST_Roofs"), doorTypes = await types("OST_Doors");
const colTypes = await types("OST_StructuralColumns"), beamTypes = await types("OST_StructuralFraming"), furnTypes = await types("OST_Furniture");
const basicWall = wallTypes.find((t) => t.FamilyName === "Basic Wall")?.FamilyTypeId, curtain = wallTypes.find((t) => t.FamilyName === "Curtain Wall")?.FamilyTypeId;
const floorType = floorTypes.find((t) => t.FamilyName === "Floor")?.FamilyTypeId, roofType = roofTypes.find((t) => t.FamilyName === "Basic Roof")?.TypeName;
const door = doorTypes[0]?.FamilyTypeId, column = colTypes.find((t) => !/Reference/.test(t.FamilyName))?.FamilyTypeId ?? colTypes[0]?.FamilyTypeId;
const beam = beamTypes.find((t) => !/Reference/.test(t.FamilyName))?.TypeName ?? beamTypes[0]?.TypeName, chair = furnTypes[0]?.FamilyTypeId;
log(`sandbox ${info?.active?.title}: levels ${GF} / ${FF} / ${ROOF}; wall ${wall} floor ${floor} roof ${roof} topo ${topo}; types wall ${basicWall} curtain ${curtain} floor ${floorType} door ${door} column ${column} beam ${beam}`);

const fg = (await send("fmc_element_geometry", { ids: [floor] }))?.elements?.[0];
const floorMid = fg?.bbox_min_mm ? [(fg.bbox_min_mm[0] + fg.bbox_max_mm[0]) / 2, (fg.bbox_min_mm[1] + fg.bbox_max_mm[1]) / 2] : [0, 0];
const X = 60000;  // new work 60 m east of the house, clear of everything
const rect = (x, y, w, d) => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
const W = (x, y, x2, y2, extra = {}) => ({ op: "create_wall", level: GF, start_mm: [x, y], end_mm: [x2, y2], height_mm: 3000, ...(basicWall ? { type_id: basicWall } : {}), ...extra });

function cases() {
  const c = [];
  const add = (group, name, ops) => c.push({ group, name, ops });
  // core
  add("core", "create_wall", [W(X, 0, X + 6000, 0)]);
  add("core", "create_wall polyline", [{ op: "create_wall", level: GF, points_mm: [...rect(X, 5000, 6000, 4000), [X, 5000]], height_mm: 3000 }]);
  add("core", "place_family door hosted on $1", [W(X, 0, X + 6000, 0), { op: "place_family", type_id: door, points_mm: [[X + 3000, 0]], level: GF, host: "$1" }]);
  add("core", "create_floor with a hole", [{ op: "create_floor", level: GF, loops_mm: [rect(X, 10000, 6000, 4000), rect(X + 2000, 11000, 1000, 1000)], ...(floorType ? { type_id: floorType } : {}) }]);
  add("core", "create_ceiling", [{ op: "create_ceiling", level: GF, outline_mm: rect(X, 10000, 6000, 4000), offset_mm: 2700 }]);
  add("core", "create_room in walls", [{ op: "create_wall", level: GF, points_mm: [...rect(X, 15000, 5000, 4000), [X, 15000]], height_mm: 3000 }, { op: "create_room", level: GF, points_mm: [[X + 2500, 17000]], name: "NIGHT ROOM", number: "N01" }]);
  add("core", "rehost to FF", [W(X, 20000, X + 4000, 20000), { op: "rehost", ids: ["$1"], level: FF }]);
  add("core", "edit_sketch floor", [{ op: "create_floor", level: GF, outline_mm: rect(X, 22000, 4000, 3000) }, { op: "edit_sketch", id: "$1", outline_mm: [[X, 22000], [X + 5000, 22000], [X + 5000, 25000], [X + 2500, 26000], [X, 25000]] }]);
  add("core", "wall_profile gable", [W(X, 27000, X + 6000, 27000), { op: "wall_profile", id: "$1", profile_mm: [[0, 0], [6000, 0], [6000, 3000], [3000, 4500], [0, 3000]] }]);
  add("core", "wall_profile arch opening", [W(X, 29000, X + 6000, 29000), { op: "wall_profile", id: "$1", loops_mm: [[[0, 0], [6000, 0], [6000, 3000], [0, 3000]], [[2000, 900], [4000, 900], [4000, 1800], { to: [2000, 1800], through: [3000, 2500] }]] }]);
  // modify
  add("modify", "move with z", [W(X, 31000, X + 3000, 31000), { op: "move", ids: ["$1"], vector_mm: [500, 0, 500] }]);
  add("modify", "copy x3 (array)", [W(X, 33000, X + 3000, 33000), { op: "copy", ids: ["$1"], vector_mm: [0, 500, 0], count: 3 }]);
  add("modify", "rotate", [W(X, 36000, X + 3000, 36000), { op: "rotate", ids: ["$1"], angle_deg: 45 }]);
  add("modify", "mirror", [W(X, 38000, X + 3000, 38000), { op: "mirror", ids: ["$1"], line_mm: [[X + 4000, 37000], [X + 4000, 40000]] }]);
  add("modify", "radial_array", [W(X, 41000, X + 2000, 41000), { op: "radial_array", ids: ["$1"], count: 4, center_mm: [X, 41000] }]);
  add("modify", "offset copy", [W(X, 43000, X + 3000, 43000), { op: "offset", ids: ["$1"], distance_mm: 1000 }]);
  add("modify", "split", [W(X, 45000, X + 6000, 45000), { op: "split", id: "$1", point_mm: [X + 3000, 45000], gap_mm: 100 }]);
  add("modify", "extend to a wall", [W(X, 47000, X + 3000, 47000), W(X + 5000, 46000, X + 5000, 49000), { op: "extend", ids: ["$1"], target: "$2" }]);
  add("modify", "wall_join off", [W(X, 50000, X + 3000, 50000), { op: "wall_join", ids: ["$1"], allow: false }]);
  add("modify", "join wall and floor", [W(X, 52000, X + 4000, 52000), { op: "create_floor", level: GF, outline_mm: rect(X - 500, 51500, 5000, 1000) }, { op: "join", ids: ["$1", "$2"] }]);
  add("modify", "pin and unpin", [W(X, 54000, X + 3000, 54000), { op: "pin", ids: ["$1"] }, { op: "unpin", ids: ["$1"] }]);
  add("modify", "set_param Comments (existing)", [{ op: "set_param", ids: [wall], param: "Comments", value_text: "night test" }]);
  add("modify", "change_type (existing)", [{ op: "change_type", ids: [wall], type_id: basicWall }]);
  add("modify", "delete (existing)", [{ op: "delete", ids: [spareWall] }]);
  add("modify", "duplicate_type wall with layers", [{ op: "duplicate_type", type: basicWall, new_name: "NIGHT Wall 250", layers: [{ function: "Finish1", width_mm: 15 }, { function: "Structure", width_mm: 220 }, { function: "Finish2", width_mm: 15 }] }]);
  add("modify", "duplicate_type floor with layers", [{ op: "duplicate_type", type: floorType, new_name: "NIGHT Slab 250", layers: [{ function: "Finish1", width_mm: 50 }, { function: "Structure", width_mm: 200 }] }]);
  add("modify", "create_group and ungroup", [W(X, 56000, X + 3000, 56000), { op: "create_group", ids: ["$1"], name: "NIGHT Group" }, { op: "ungroup", ids: ["$2"] }]);
  add("modify", "demolish", [W(X, 58000, X + 3000, 58000), { op: "demolish", ids: ["$1"] }]);
  // roofs, stairs, rails, openings
  add("roofs", "create_roof hip with overhang", [{ op: "create_roof", level: ROOF, outline_mm: rect(X, 60000, 8000, 6000), slope_deg: 30, overhang_mm: 600, ...(roofType ? { type_name: roofType } : {}) }]);
  add("roofs", "create_roof gable + attach walls", [W(X, 67000, X + 8000, 67000, { height_mm: 6000 }), { op: "create_roof", level: ROOF, outline_mm: rect(X, 66000, 8000, 6000), slopes_deg: [30, null, 30, null] }, { op: "attach", ids: ["$1"], target: "$2", side: "top" }]);
  add("roofs", "fascia and gutter on a new roof", [{ op: "create_roof", level: ROOF, outline_mm: rect(X, 74000, 6000, 5000), slope_deg: 25 }, { op: "fascia", host: "$1" }, { op: "gutter", host: "$1" }]);
  add("roofs", "roof_extrusion on a reference plane", [{ op: "reference_plane", name: "NIGHT_RP", start_mm: [X, 80000], end_mm: [X + 6000, 80000], cut_mm: [0, 0, 1] }, { op: "roof_extrusion", plane: "NIGHT_RP", level: ROOF, profile_mm: [[0, 7250], [3000, 9000], [6000, 7250]], start_mm: 0, end_mm: 4000 }]);
  add("stairs", "create_stair one run", [{ op: "create_stair", base_level: GF, top_level: FF, runs: [{ start_mm: [X, 85000], end_mm: [X, 90000], width_mm: 1000 }] }]);
  add("stairs", "create_stair two runs", [{ op: "create_stair", base_level: GF, top_level: FF, runs: [{ start_mm: [X + 4000, 85000], direction_deg: 90, risers: 10, width_mm: 1000 }, { start_mm: [X + 5200, 88500], direction_deg: 270, width_mm: 1000 }] }]);
  add("stairs", "create_railing path", [{ op: "create_railing", level: FF, path_mm: [[X, 92000], [X + 4000, 92000], [X + 4000, 94000]] }]);
  add("openings", "opening in a new floor", [{ op: "create_floor", level: GF, outline_mm: rect(X, 96000, 5000, 4000) }, { op: "opening", host: "$1", outline_mm: rect(X + 1000, 97000, 1000, 1000) }]);
  add("openings", "shaft", [{ op: "shaft", base_level: GF, top_level: FF, outline_mm: rect(X, 101000, 1500, 1500) }]);
  add("openings", "wall_opening", [W(X, 104000, X + 6000, 104000), { op: "wall_opening", wall: "$1", start_mm: [X + 1000, 104000, 950], end_mm: [X + 2500, 104000, 2450] }]);
  add("openings", "room_separation", [{ op: "room_separation", level: GF, lines_mm: [[[X, 106000], [X + 4000, 106000]]] }]);
  add("arch", "curtain wall grid and mullions", [W(X, 108000, X + 6000, 108000, { type_id: curtain }), { op: "curtain_grid", wall: "$1", vertical_mm: [1500, 3000, 4500], horizontal_mm: [1200] }, { op: "mullions", wall: "$1" }]);
  add("arch", "wall_sweep", [W(X, 110000, X + 4000, 110000), { op: "wall_sweep", ids: ["$1"], height_mm: 300 }]);
  add("arch", "area plan + area", [{ op: "area_plan", level: GF, name: "NIGHT Area" }]);
  // views, sheets, annotation
  add("views", "plan, section, 3d, camera, drafting", [
    { op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan", scale: 100 }, { op: "create_view", kind: "section", line_mm: [[0, -5000], [20000, -5000]], name: "NIGHT Section" },
    { op: "create_view", kind: "3d", name: "NIGHT 3D", section_box_mm: [[-5000, -5000, 0], [30000, 30000, 10000]] }, { op: "create_view", kind: "camera", name: "NIGHT Camera", eye_mm: [-10000, -10000, 1700], target_mm: [10000, 10000, 1500] },
    { op: "create_view", kind: "drafting", name: "NIGHT Drafting" }]);
  add("views", "elevation, callout, duplicate, set_view", [{ op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan 2" }, { op: "create_view", kind: "elevation", point_mm: [5000, -8000], plan: "$1", face: 1, name: "NIGHT Elev" },
    { op: "create_view", kind: "callout", parent: "$1", box_mm: [[0, 0], [5000, 5000]], name: "NIGHT Callout" }, { op: "duplicate_view", view: "$1", mode: "with_detailing", name: "NIGHT Plan dup" },
    { op: "set_view", view: "$1", scale: 50, detail_level: "Fine", crop_mm: [[-2000, -2000], [25000, 20000]], crop_visible: true, view_range_mm: { top: 2600, cut: 1200, bottom: 0, depth: 0 } }]);
  add("views", "override, hide, filter, template", [{ op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan 3" }, { op: "override", view: "$1", categories: ["Walls"], color: [200, 0, 0], line_weight: 5 },
    { op: "hide", view: "$1", categories: ["Furniture"] }, { op: "create_filter", name: "NIGHT Filter", categories: ["Walls"], rules: [{ param: "Comments", op: "contains", value: "night" }] },
    { op: "override", view: "$1", filter: "$4", color: [0, 0, 200] }, { op: "create_template", view: "$1", name: "NIGHT Template" }, { op: "apply_template", template: "NIGHT Template", views: ["$1"], once: true }]);
  add("sheets", "create_sheet + place_view", [{ op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan 4" }, { op: "create_sheet", number: "N-101", name: "Night sheet" }, { op: "place_view", sheet: "$2", view: "$1" }]);
  add("annotate", "detail line, regions, text, tag, spot", [{ op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan 5" },
    { op: "detail_line", view: "$1", points_mm: [[0, 0], [3000, 0], [3000, 3000]] }, { op: "filled_region", view: "$1", outline_mm: rect(0, 0, 1000, 1000) }, { op: "masking_region", view: "$1", outline_mm: rect(2000, 0, 1000, 1000) },
    { op: "text", view: "$1", point_mm: [0, -1000], text: "Night test" }, { op: "tag", view: "$1", ids: [wall] }, { op: "spot_elevation", view: "$1", id: floor, point_mm: floorMid }]);
  add("annotate", "revision + cloud + colour legend", [{ op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan 6" }, { op: "revision", description: "Night test" }, { op: "revision_cloud", view: "$1", outline_mm: rect(0, 0, 4000, 4000) }, { op: "color_fill_legend", view: "$1", category: "Rooms", point_mm: [20000, 0] }]);
  add("schedules", "schedule, takeoff, sheet list", [{ op: "create_schedule", category: "Walls", fields: ["Family and Type", "Length"], sort: ["Family and Type"], name: "NIGHT Walls" }, { op: "create_schedule", kind: "material_takeoff", category: "Walls", name: "NIGHT Takeoff" }, { op: "create_schedule", kind: "sheet_list", name: "NIGHT Sheets" }]);
  // settings
  add("settings", "material, styles, patterns", [{ op: "create_material", name: "NIGHT Material", color: [120, 80, 40] }, { op: "line_style", name: "NIGHT Line", weight: 3, color: [0, 0, 0] },
    { op: "line_pattern", name: "NIGHT Dash", segments: [{ kind: "dash", length_mm: 3 }, { kind: "space", length_mm: 1.5 }] }, { op: "fill_pattern", name: "NIGHT Hatch", angle_deg: 45, spacing_mm: 2 }, { op: "object_style", category: "Walls", weight: 4 }]);
  add("settings", "project info, units, global param, selection, purge", [{ op: "project_info", params: { "Client Name": "Night test" } }, { op: "project_units", length: "Millimeters", length_accuracy: 1 },
    { op: "global_param", name: "NIGHT_Width", type: "Length", value: 900 }, { op: "save_selection", name: "NIGHT Selection", ids: [wall] }, { op: "purge" }]);
  add("settings", "coordinates", [{ op: "coordinates", angle_deg: 5 }]);
  // structure, MEP, site
  add("structure", "column, beam, structural floor", [{ op: "column", level: GF, top_level: FF, points_mm: [[X, 115000], [X + 6000, 115000]], type_id: column },
    { op: "beam", level: FF, start_mm: [X, 115000, 0], end_mm: [X + 6000, 115000, 0], ...(beam ? { type_name: beam } : {}) }, { op: "structural_floor", level: FF, outline_mm: rect(X, 115000, 6000, 4000) }]);
  add("structure", "analytical member, load case, combination", [{ op: "analytical_member", start_mm: [X, 120000, 450], end_mm: [X + 6000, 120000, 450] }, { op: "load_case", name: "NIGHT Dead", category: "dead" }, { op: "load_combination", name: "NIGHT Combo", cases: [{ case: "NIGHT Dead", factor: 1.4 }] }]);
  add("structure", "boundary condition + point load", [{ op: "analytical_member", start_mm: [X, 122000, 450], end_mm: [X + 6000, 122000, 450] }, { op: "boundary_condition", host: "$1", fixity: "pinned" }, { op: "point_load", host: "$1", point_mm: [X + 3000, 122000, 450], force_kn: [0, 0, -10] }]);
  add("mep", "duct (no duct types loaded: expect a clear refusal)", [{ op: "duct", level: GF, points_mm: [[X, 125000, 2800], [X + 4000, 125000, 2800]], width_mm: 400, height_mm: 300 }]);
  add("mep", "space + zone + check_systems", [{ op: "space", level: GF, points_mm: [[X + 2500, 17000]] }, { op: "check_systems" }]);
  add("site", "toposolid from points + subdivision", [{ op: "toposolid", level: levels[0], points_mm: [[X, 130000, 0], [X + 10000, 130000, 500], [X + 10000, 140000, 1000], [X, 140000, 300]] }, { op: "toposolid_subdivision", host: "$1", outline_mm: rect(X + 2000, 132000, 3000, 3000) }]);
  add("site", "building pad", [{ op: "building_pad", level: levels[0], outline_mm: rect(X, 145000, 6000, 4000) }]);
  add("other", "assembly, parts, paint", [W(X, 150000, X + 4000, 150000), { op: "assembly", ids: ["$1"], name: "NIGHT Assembly" }]);
  add("other", "furniture place_family unhosted", [{ op: "place_family", type_id: chair, points_mm: [[X, 152000]], level: GF }]);
  // section boxes (owner 27 Oct)
  add("boxes", "section_box new view around a wall", [{ op: "section_box", ids: [wall], margin_mm: 500, from: "iso_ne", name: "NIGHT Box wall" }]);
  add("boxes", "section_box storey slice + cut + grow", [{ op: "section_box", level: GF, cut_mm: 1200, grow_mm: { north: 2000, top: -100 }, name: "NIGHT Box GF cut" }]);
  add("boxes", "section_box 3D section along a line", [{ op: "section_box", cut_line_mm: [[0, floorMid[1]], [20000, floorMid[1]]], keep: "left", depth_mm: 8000, name: "NIGHT Box cut line" }]);
  add("boxes", "section_box turned along a wall, then off", [{ op: "section_box", ids: [wall], along: wall, name: "NIGHT Box along" }, { op: "section_box", view: "$1", off: true }]);
  add("boxes", "section_box plan crop + view range", [{ op: "create_view", kind: "floor_plan", level: GF, name: "NIGHT Plan box" }, { op: "section_box", view: "$1", ids: [wall], margin_mm: 1000, view_range: true }]);
  add("display", "display_mode navigate then render", [{ op: "section_box", ids: [wall], name: "NIGHT Display" },
    { op: "display_mode", mode: "navigate", views: ["$1"], detail: "coarse" }, { op: "display_mode", mode: "render", views: ["$1"] }]);
  add("boxes", "box_views per level", [{ op: "box_views", per: "level", prefix: "NIGHT Box" }]);
  add("boxes", "box_views per element", [{ op: "box_views", per: "element", items: [wall, floor], prefix: "NIGHT Box" }]);
  add("site", "site_floor on a toposolid, excavating", [{ op: "toposolid", level: levels[0], points_mm: [[X, 160000, 0], [X + 10000, 160000, 600], [X + 10000, 170000, 900], [X, 170000, 300]] },
    { op: "site_floor", level: levels[0], topo: "$1", outline_mm: rect(X + 3000, 163000, 3000, 3000), at: "highest" }]);
  add("modify", "mirror a door, keeping its side", [W(X, 175000, X + 6000, 175000), W(X, 178000, X + 6000, 178000), { op: "place_family", type_id: door, points_mm: [[X + 3000, 175000]], level: GF, host: "$1" },
    { op: "mirror", ids: ["$3"], line_mm: [[X, 176500], [X + 6000, 176500]] }]);
  // depth on every op (owner 27 Oct): select, {select} in place of an id, for_each
  add("depth", "set_param on walls found by select", [{ op: "set_param", select: { category: "Walls", level: GF, limit: 5000 }, param: "Comments", value_text: "night depth" }]);
  add("depth", "door hosted by a {select} wall", [W(X, 190000, X + 6000, 190000), { op: "place_family", type_id: door, points_mm: [[X + 3000, 190000]], level: GF, host: { select: { category: "Walls", near: { point_mm: [X + 3000, 190000], within_mm: 200 } } } }]);
  add("depth", "for_each point: three walls", [{ op: "for_each", per: "point", items: [[X, 193000], [X, 194000], [X, 195000]], ops: [{ op: "create_wall", level: GF, start_mm: "{center_mm}", end_mm: [X + 3000, 193000], height_mm: 3000 }] }]);
  add("depth", "for_each level: a plan each", [{ op: "for_each", per: "level", ops: [{ op: "create_view", kind: "floor_plan", level: "{name}", name: "NIGHT FE {name}" }] }]);
  add("depth", "for_each room: a boxed view each", [{ op: "for_each", per: "room", ops: [{ op: "section_box", room: "{id}", name: "NIGHT FE Room {number}" }] }]);
  add("depth", "for_each element (select) with @1", [{ op: "for_each", per: "element", select: { category: "Walls", level: GF, limit: 3 }, ops: [{ op: "create_view", kind: "3d", name: "NIGHT FE wall {id}" }, { op: "section_box", view: "@1", ids: ["{id}"] }] }]);
  add("steel", "steel plate", [{ op: "steel_plate", points_mm: [[X, 155000, 450], [X + 500, 155000, 450], [X + 500, 155500, 450], [X, 155500, 450]], thickness_mm: 12 }]);
  return c;
}

async function reads() {
  await test("reads", "model_check", "fmc_model_check", { limit: 20 }, (r) => typeof r?.problems === "number");
  await test("reads", "material_report", "fmc_material_report", { limit: 10 }, (r) => typeof r?.summary?.materials === "number" && Array.isArray(r?.advice));
  await test("reads", "select_by level + category", "fmc_select_by", { level: GF, category: "Walls" }, (r) => r?.count > 0);
  await test("reads", "select_by box", "fmc_select_by", { box_mm: [[0, 0], [20000, 20000]] }, (r) => r?.count > 0);
  // speed (owner 27 Oct): Revit's quick filters first; compare these times run to run in results.json (ms)
  await test("speed", "select_by everything", "fmc_select_by", { limit: 1 }, (r) => r?.count > 0);
  await test("speed", "select_by one category", "fmc_select_by", { category: "Walls", limit: 1 }, (r) => r?.count > 0);
  await test("speed", "select_by categories by name", "fmc_select_by", { category: ["Doors", "Windows", "Plumbing Fixtures"], limit: 1 }, (r) => typeof r?.count === "number");
  await test("speed", "select_by near a point", "fmc_select_by", { near: { point_mm: [0, 0], within_mm: 5000 }, limit: 1 }, (r) => typeof r?.count === "number");
  await test("speed", "select_by type and param", "fmc_select_by", { category: "Walls", param: { name: "Length", is: "gt", value: 1000 }, limit: 1 }, (r) => typeof r?.count === "number");
  await test("reads", "get_element_geometry", "fmc_element_geometry", { ids: [wall, floor, roof] }, (r) => r?.elements?.length === 3);
  await test("reads", "design options", "fmc_design_options", {}, (r) => !!r);
  await test("reads", "list commands", "fmc_list_commands", {}, (r) => r?.count > 500);
  const pic = await test("reads", "see_view close-up", "fmc_view_image", { ids: [wall], size: 800 }, (r) => !!r?.file && fs.existsSync(r.file));
  if (pic?.file && fs.existsSync(pic.file)) fs.copyFileSync(pic.file, path.join(OUT, "see_view_wall.png"));
  // owner 27 Oct: section-box pictures
  for (const [name, params] of [
    ["see_view box storey cut", { box: { level: GF, cut_mm: 1200 }, from: "top", size: 800 }],
    ["see_view box slice + grow", { ids: [wall], box: { slice: { at_mm: 1500, keep: "below" }, grow_mm: { top: 500 } }, size: 800 }],
    ["see_view perspective", { ids: [wall], perspective: true, size: 800 }],
    ["see_view perspective inside a storey", { box: { level: GF }, perspective: true, from: "inside", size: 800 }],
  ]) {
    const r = await test("reads", name, "fmc_view_image", params, (x) => !!x?.file && fs.existsSync(x.file));
    if (r?.file && fs.existsSync(r.file)) fs.copyFileSync(r.file, path.join(OUT, name.replace(/[^\w]+/g, "_") + ".png"));
  }
  await test("reads", "select_by not + param", "fmc_select_by", { category: "Walls", not: { level: GF }, param: { name: "Length", is: "gt", value: 1000 } }, (r) => typeof r?.count === "number");
  await test("reads", "select_by near", "fmc_select_by", { near: { id: wall, within_mm: 3000 } }, (r) => r?.count > 0);
  await test("reads", "see_view by select", "fmc_view_image", { select: { category: "Walls", level: GF }, size: 800 }, (r) => !!r?.file);
  await test("reads", "undo list status", "fmc_undo_status", {}, (r) => r?.followed === true);
  for (const fmt of ["pdf", "dwg", "image", "ifc"])
    await test("files", `export ${fmt}`, "fmc_revit_file", { action: "export", format: fmt, folder: path.join(OUT, "exports"), name: `night_${fmt}` }, (r) => r?.exported === fmt);
}

async function familyPass() {
  const file = path.join(OUT, "NIGHT_Curved_Test.rfa");
  await test("family", "new_family", "fmc_family_new", { template: "Metric Generic Model", path: file, overwrite: true }, (r) => !!r?.family);
  const oval = Array.from({ length: 60 }, (_, i) => [Math.round(300 * Math.cos((2 * Math.PI * i) / 60) * 100) / 100, Math.round(200 * Math.sin((2 * Math.PI * i) / 60) * 100) / 100]);
  await test("family", "params, traced oval, arc revolve, spline sweep, label, save", "fmc_model_edit", { ops: [
    { op: "family_param", name: "Width", type: "Length", value: 600 }, { op: "family_param", name: "Finish", type: "Material", instance: false },
    { op: "extrusion", outline_mm: oval, end_mm: 50, material: "Finish" },
    { op: "revolve", outline_mm: [[0, 100], [150, 100], { to: [150, 400], through: [220, 250] }, [0, 400]], axis_mm: [[0, 0], [0, 500]] },
    { op: "sweep", path_mm: [[0, 600], [400, 600], [400, 1000]], profile_mm: [[0, 0], { to: [40, 0], spline: [[20, 15]] }, [40, 40], [0, 40]] },
    { op: "blend", bottom_mm: [[-100, -100], [100, -100], [100, 100], [-100, 100]], top_mm: [[-50, -50], [50, -50], [50, 50], [-50, 50]], height_mm: 300 },
    { op: "family_type", name: "NIGHT 600", params: { Width: 600 } }, { op: "save_family" }], why: "night test: family with curves" });
  if (SANDBOX) await test("family", "back to the sandbox", "fmc_revit_file", { action: "open", path: SANDBOX }, (r) => !!r?.opened);
}

function report() {
  const pass = results.filter((r) => r.ok).length;
  const lines = [`# Night test · ${MODEL} · ${new Date().toISOString()}`, "", `${pass} of ${results.length} passed.`, "",
    "| Group | Test | Result | ms | Detail |", "|---|---|---|---|---|",
    ...results.map((r) => `| ${r.group} | ${r.name} | ${r.ok ? "pass" : "**fail**"} | ${r.ms} | ${(r.detail || "").replace(/\|/g, "/")} |`)];
  fs.writeFileSync(path.join(OUT, "report.md"), lines.join("\n") + "\n");
  log(`report: ${path.join(OUT, "report.md")} (${pass}/${results.length})`);
}

try {
  if (PASS === "dry" || PASS === "all") { for (const k of cases()) await edit(k.group, k.name + " [dry]", k.ops, true); await reads(); }
  if (PASS === "real" || PASS === "all") {
    for (const k of cases()) await edit(k.group, k.name + " [real]", k.ops, false);
    await test("reads", "model_check after the real pass", "fmc_model_check", { limit: 50 }, (r) => typeof r?.problems === "number");
    // owner 27 Oct: undo_ai_batch takes a batch back (the sandbox must be the active window)
    const b = await test("undo", "a batch to undo", "fmc_model_edit", { ops: [W(X, 185000, X + 3000, 185000)], why: "night test: to be undone" }, (r) => !!r?.batch_id);
    if (b?.batch_id) {
      await test("undo", "undo_ai_batch posts the undo", "fmc_undo", { action: "undo", batch_id: b.batch_id }, (r) => r?.posted === true);
      let s;
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); s = await send("fmc_undo_status", {}); if (!s?.undo_running) break; }
      await test("undo", "the batch is gone from the undo list", "fmc_undo_status", {}, (r) => (r?.done ?? []).includes(b.batch_id) && !r?.stopped);
      const made = b.ops?.[0]?.created_ids?.[0];
      if (made) await test("undo", "its wall no longer exists", "fmc_element_geometry", { ids: [made] }, (r) => (r?.elements ?? []).length === 0);
    }
    await test("files", "save the sandbox", "fmc_revit_file", { action: "save" }, (r) => !!r?.saved);
  }
  if (PASS === "family" || PASS === "all") await familyPass();
} finally { report(); process.exit(0); }
