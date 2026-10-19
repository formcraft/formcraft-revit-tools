/**
 * Where AI-written code should move to (fmc_balance backlog): the mapping file, seeded with the KISIC inventory in
 * docs/handoff/KISIC_GAP_SCRIPTS.md §3 (script → proposed tool). A backlog group (send_code_to_revit calls with the same
 * purpose or the same code) is matched to the first entry whose keywords appear in its purpose.
 *
 * It ships with the server (compiled), so it is here as data rather than a JSON file beside the code. A person or the
 * tester adds or replaces entries without a build in %APPDATA%\Formcraft\ledger\FMC_Balance_Homes.json (an array of the
 * same shape; an entry with the same id replaces the seed's). `feature` names a docs/tracker/features.json id when the
 * proposed home has one: its status is then read from the tracker; otherwise `status` says.
 */
export interface Home {
  id: string;
  /** Words or phrases (lower case) that, found in a purpose, send the group here. */
  keywords: string[];
  /** The proposed home: a tool action, a recipe op, a kit change or a saved add-on. */
  home: string;
  /** The KISIC script(s) that did this job (docs/handoff/kisic_gap_scripts/revit). */
  scripts: string;
  priority: "P1" | "P2" | "P3";
  /** A docs/tracker/features.json id, when the home is on the tracker. */
  feature?: string;
  /** planned, in progress, built, tested: used when no tracker feature says. */
  status?: string;
}

export const KISIC_HOMES: Home[] = [
  { id: "view_screenshot", keywords: ["screenshot", "png", "pdf", "export view", "export sheet", "check view", "crop"],
    home: "fmc_view screenshot and fmc_sheets export pdf", scripts: "03_check_views.cs, 24_export_png_pdf.cs", priority: "P1" },
  { id: "circuits", keywords: ["circuit", "sld", "single line", "single-line", "riser", "distribution board", "panel", "db"],
    home: "Kit fix of the DB family + fmc_systems create_circuits, then fmc_diagram (drafting fallback as an add-on)", scripts: "14_sld_riser_drafting.cs", priority: "P1" },
  { id: "light_source", keywords: ["light source", "lumen", "photometric", "light type"],
    home: "Recipe op set_light_source", scripts: "16_family_light_source.cs", priority: "P1" },
  { id: "visibility", keywords: ["hide box", "clearance", "envelope", "connector pad", "visibility", "hide boxes"],
    home: "Kit rule + fmc_recipe check rule + fmc_family fix_visibility", scripts: "22a_hide_boxes_views.cs, 23_family_hide_boxes.cs", priority: "P1" },
  { id: "switch_param", keywords: ["switch param", "fmc switch", "switch id", "shared parameter"],
    home: "Kit shared-parameter file + template binding (no code)", scripts: "19_fmc_switch_param.cs", priority: "P1" },
  { id: "sheet_layout", keywords: ["sheet layout", "layout sheet", "place view", "viewport", "title block", "sheet"],
    home: "fmc_sheets layout (and a sheet lint)", scripts: "20a_legends_sheet.cs, 24_export_png_pdf.cs", priority: "P1" },
  { id: "legend", keywords: ["legend"],
    home: "fmc_legend build", scripts: "20a_legends_sheet.cs, 22b_legend_relayout.cs", priority: "P2" },
  { id: "orphans", keywords: ["orphan", "rehost", "re-host", "host == null", "floating", "relight"],
    home: "fmc_qa orphans (+ rehost_to_face)", scripts: "15_flat_ceilings_relight.cs", priority: "P2" },
  { id: "ceiling", keywords: ["ceiling"],
    home: "Add-on ceiling_from_room", scripts: "03b_ceilings.cs, 15_flat_ceilings_relight.cs", priority: "P2" },
  { id: "strips", keywords: ["strip", "led strip", "perimeter"],
    home: "Add-on strips_on_room_walls", scripts: "06_lighting.cs, 12_*, 18_veranda_switching.cs", priority: "P2" },
  { id: "lighting", keywords: ["light", "lighting", "fitting", "luminaire", "downlight", "switching"],
    home: "Add-ons lights_on_ceiling and rehost_to_face", scripts: "06_lighting.cs, 12_*, 18_veranda_switching.cs", priority: "P2" },
  { id: "power_plan", keywords: ["power plan", "socket", "symbol", "home run", "device"],
    home: "fmc_annotate power", scripts: "07_devices_mep_equipment.cs, 17_power_plan.cs", priority: "P2" },
  { id: "circuit_key", keywords: ["key", "swatch", "fan"],
    home: "fmc_annotate key (+ kit fan with light kit)", scripts: "20b_fan_keys.cs", priority: "P2" },
  { id: "emissive", keywords: ["emissive", "luminance", "render material", "glow"],
    home: "fmc_material emissive", scripts: "11_render_materials.cs", priority: "P2" },
  { id: "finishes", keywords: ["paint", "finish", "material param"],
    home: "Kit fix (paints = colour) + recipe rule + add-on paint_faces_by_rule", scripts: "04_finishes.cs, 13_materials_finish_pass.cs", priority: "P2" },
  { id: "place", keywords: ["furniture", "equipment", "casework", "placeholder", "place"],
    home: "Add-on place_from_json", scripts: "05_furniture.cs, 09_casework_equipment_placeholders.cs", priority: "P2" },
  { id: "boq", keywords: ["boq", "bill of quant", "quantit", "cable estimate"],
    home: "fmc_report boq", scripts: "21_boq_export.cs", priority: "P2" },
  { id: "shell", keywords: ["wall", "shell", "join", "door", "opening", "slab"],
    home: "fmc_qa walls + add-on shell_from_json", scripts: "01_shell.cs", priority: "P2" },
  { id: "rooms", keywords: ["room"],
    home: "Add-on rooms_from_json (+ area tolerance report)", scripts: "02_rooms.cs", priority: "P3" },
  { id: "canopy", keywords: ["canopy", "soffit"],
    home: "Add-on slab_soffit_from_polygon", scripts: "20c_east_canopy.cs", priority: "P3" },
  { id: "pipework", keywords: ["pipe", "tank", "gully", "gullies", "condensate", "refrigerant"],
    home: "Out of scope for now: keep as reference", scripts: "08_pipework_tank_gullies.cs", priority: "P3" },
];

/** The seed with a person's entries laid over it (same id replaces, a new id is added at the front so it matches first). */
export function mergeHomes(seed: Home[], own: unknown): Home[] {
  if (!Array.isArray(own)) return seed;
  const valid = own.filter((h): h is Home => !!h && typeof h === "object" && typeof (h as Home).id === "string" &&
    Array.isArray((h as Home).keywords) && typeof (h as Home).home === "string")
    .map((h): Home => ({ ...h, scripts: h.scripts ?? "", priority: h.priority ?? "P2", keywords: h.keywords.map((k) => String(k).toLowerCase()) }));
  const all = [...valid.filter((h) => !seed.some((s) => s.id === h.id)), ...seed.map((s) => valid.find((h) => h.id === s.id) ?? s)];
  return all.filter((h, i) => all.findIndex((x) => x.id === h.id) === i);
}
