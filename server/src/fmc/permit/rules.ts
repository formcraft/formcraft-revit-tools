/**
 * The fmc_permit_check rule table. Structure only: which instrument and clause, which bank keys hold the numbers,
 * which caveat ids from FMC_Standards_Sources.json apply, and which phase can check it. No regulation value is here;
 * the numbers come from the standards bank at run time.
 */
export type RuleGroup = "class" | "pack" | "docs" | "rooms" | "stairs" | "escape" | "fire" | "site" | "daylight" | "doors" | "accessibility";

export interface PermitRule {
  id: string;
  group: RuleGroup;
  topic: string;
  /** Source id as in the standards bank (UG-BCR-2020 ...), or "FMC kit" for Formcraft typical values. */
  instrument: string;
  /** Used only when the bank entry has no clause of its own. */
  clause: string;
  keys: string[];
  /** A = runs now on installed read commands. B = needs fmc_permit_facts (add-in). C = later. */
  phase: "A" | "B" | "C";
  /** Formcraft typical values: ADVICE only, never a breach. */
  advice?: boolean;
  caveats: string[];
  summary: string;
}

export const PERMIT_RULES: PermitRule[] = [
  { id: "CLASS.category", group: "class", topic: "Permit category", instrument: "UG-BCR-2020 / UG-BCA-2013 / UG-BC-AMEND-2026", clause: "BCR reg 8, Schedule 2; BCA s.2; Amendment s.9(b)",
    keys: ["permits.building_category", "permits.minor_works_definition", "permits.multistorey_definition"], phase: "A", caveats: [],
    summary: "Derived category A, B or C from floor area, storeys, height and use. Advisory; the Building Committee classifies." },
  { id: "CLASS.multistorey_docs", group: "class", topic: "Multi-storey submissions", instrument: "UG-BC-AMEND-2026", clause: "s.9 (Cap.136 s.34(3), (3a))",
    keys: ["permits.multistorey_definition", "permits.multistorey_submission"], phase: "A", caveats: [],
    summary: "Over the multi-storey height: engineering design, geotechnical report and excavation support design are needed." },
  { id: "SITE.excavation", group: "site", topic: "Deep excavation", instrument: "UG-BCR-2020", clause: "reg 32(2)",
    keys: ["site.deep_excavation_temporary_works"], phase: "A", caveats: [],
    summary: "A level below ground deeper than the trigger needs temporary works approval if not on the approved plans." },
  { id: "PACK.arch_set", group: "pack", topic: "Architectural drawing set", instrument: "UG-BCR-2020", clause: "reg 9",
    keys: ["drawings.architectural_set"], phase: "A", caveats: [],
    summary: "Each sheet the Regulations list is found among the model's sheets (by sheet or view name)." },
  { id: "PACK.arch_scales", group: "pack", topic: "Drawing scales", instrument: "UG-BCR-2020", clause: "reg 9",
    keys: ["drawings.architectural_set"], phase: "A", caveats: [],
    summary: "Views placed on sheets use a scale the Regulations allow for their kind (site, layouts, sections and elevations)." },
  { id: "PACK.room_use", group: "pack", topic: "Use of every room shown", instrument: "UG-BCR-2020", clause: "reg 13",
    keys: ["drawings.general"], phase: "A", caveats: [],
    summary: "Every placed room has a name (its use). Rooms not placed or not enclosed are listed." },
  { id: "PACK.paper", group: "pack", topic: "Signature, lettering, north point, copies", instrument: "UG-BCR-2020", clause: "reg 13",
    keys: ["drawings.general"], phase: "C", caveats: ["BCR-1"],
    summary: "Paper and signature requirements. Not visible in a model." },
  { id: "PACK.other_sets", group: "pack", topic: "Structural, electrical and mechanical sets", instrument: "UG-BCR-2020", clause: "regs 10-12",
    keys: ["drawings.structural_set", "drawings.electrical_set", "drawings.mechanical_set"], phase: "C", caveats: [],
    summary: "Other discipline sets live in other models. Not read in Phase A." },
  { id: "DOCS.attach", group: "docs", topic: "Documents to attach", instrument: "UG-BCR-2020", clause: "regs 19, 21, 22",
    keys: ["permits.application_minor_works", "permits.application_residential_commercial", "permits.application_complex_public_extra"], phase: "A", caveats: ["UG-BCR-2020-G1"],
    summary: "The application documents for the derived category. A model cannot show them." },
  { id: "ROOMS.habitable", group: "rooms", topic: "Habitable room area", instrument: "UG-NBC-2019", clause: "para 102",
    keys: ["rooms.habitable_first_min", "rooms.habitable_additional_min", "rooms.sleeping_area_per_person"], phase: "A", caveats: ["NBC-4"],
    summary: "Habitable rooms at least the additional-room minimum; below the first-room minimum is REVIEW." },
  { id: "ROOMS.kitchen", group: "rooms", topic: "Kitchen area", instrument: "UG-NBC-2019", clause: "para 103(2)(a)",
    keys: ["rooms.kitchen_min"], phase: "A", caveats: ["UG-NBC-2019-C3"],
    summary: "Kitchen at least the standard minimum; between the small-unit and standard minimum is REVIEW." },
  { id: "ROOMS.bathroom", group: "rooms", topic: "Bathroom or WC area", instrument: "UG-NBC-2019", clause: "para 103(2)(g)",
    keys: ["rooms.bathroom_legal_min"], phase: "A", caveats: [],
    summary: "Bathrooms and WC cubicles at least the legal minimum." },
  { id: "ROOMS.typical", group: "rooms", topic: "Formcraft typical room sizes", instrument: "FMC kit", clause: "Formcraft typical value (not law)",
    keys: ["rooms.bedroom_single_min", "rooms.living_min", "rooms.bathroom_min", "rooms.wc_min"], phase: "A", advice: true, caveats: [],
    summary: "Formcraft's own typical minimums. ADVICE only." },
  { id: "STAIRS.dims", group: "stairs", topic: "Stair rise, going, width, headroom", instrument: "UG-NBC-2019", clause: "paras 41-43",
    keys: ["stairs.riser_max", "stairs.going_min", "stairs.width_min", "stairs.headroom"], phase: "B", caveats: ["NBC-1", "UG-NBC-2019-C8"],
    summary: "Stair geometry is not read in Phase A, and the thresholds depend on dwelling vs other residential (Q3)." },
  { id: "ESCAPE.second_stair", group: "escape", topic: "Second staircase", instrument: "UG-NBC-2019", clause: "para 49(2)",
    keys: ["escape.second_staircase"], phase: "A", caveats: [],
    summary: "Over the storey or top-floor height trigger, at least two stairs." },
  { id: "FIRE.compartment", group: "fire", topic: "Compartment floor area", instrument: "UG-NBC-2019", clause: "para 40(1)",
    keys: ["fire.compartment_max_floor_area"], phase: "A", caveats: ["NBC-10"],
    summary: "Floor area per level against the compartment maximum (compartments are not modelled: over is REVIEW)." },
  { id: "SITE.plot_coverage", group: "site", topic: "Plot coverage", instrument: "UG-PPSG-2011", clause: "Table 1; 2.4; 3.4",
    keys: ["planning.residential.plot_coverage_max", "planning.commercial.plot_coverage_max"], phase: "A", caveats: ["UG-NBC-2019-G1"],
    summary: "Ground-floor footprint over plot area, when the caller gives plot area and zone." },
  // Phase B and C: listed so the report shows what was not checked and why.
  { id: "ROOMS.ceiling_height", group: "rooms", topic: "Ceiling height", instrument: "UG-NBC-2019", clause: "para 24",
    keys: ["ceilings.habitable", "rooms.kitchen_height"], phase: "B", caveats: ["UG-NBC-2019-C2"], summary: "Needs room ceiling heights (fmc_permit_facts)." },
  { id: "DAYLIGHT.glazing", group: "daylight", topic: "Glazed area", instrument: "UG-NBC-2019", clause: "paras 113(1), 158(5)",
    keys: ["windows.glazed_area_ratio"], phase: "B", caveats: ["UG-NBC-2019-C5"], summary: "Needs window sizes per room (fmc_permit_facts)." },
  { id: "DAYLIGHT.openable", group: "daylight", topic: "Openable area", instrument: "UG-NBC-2019", clause: "paras 156(4), 157(1)",
    keys: ["windows.openable_ratio"], phase: "B", caveats: ["UG-NBC-2019-C4"], summary: "Needs an openable-area parameter per window." },
  { id: "DOORS.accessible_width", group: "doors", topic: "Accessible door clear width", instrument: "UG-ACC-2019", clause: "para 10(2)-(3)",
    keys: ["doors.accessible_clear_width"], phase: "B", caveats: ["ACC-4"], summary: "Needs door clear widths (fmc_permit_facts)." },
  { id: "ACCESS.wc_ramp", group: "accessibility", topic: "Accessible WC and ramps", instrument: "UG-ACC-2019", clause: "paras 12(3), 17(2)",
    keys: ["accessibility.wc_cubicle", "accessibility.ramp"], phase: "B", caveats: ["ACC-1", "ACC-4"], summary: "Needs ramp slopes and WC room shapes." },
  { id: "ESCAPE.travel", group: "escape", topic: "Travel distance to a stair", instrument: "UG-NBC-2019", clause: "para 105(1)(d)",
    keys: ["escape.max_distance_to_stair"], phase: "C", caveats: [], summary: "Needs a path calculation." },
  { id: "FIRE.equipment", group: "fire", topic: "Hose reels, hydrants, sprinklers, extinguishers", instrument: "UG-MECH-2019", clause: "paras 131-134",
    keys: ["fire.hose_reels", "fire.hydrants", "fire.sprinklers", "fire.extinguishers"], phase: "C", caveats: [], summary: "Needs fire equipment and occupancy classes." },
  { id: "SITE.building_line", group: "site", topic: "Building line", instrument: "UG-NBC-2019", clause: "para 8(3)",
    keys: ["site.building_line"], phase: "C", caveats: [], summary: "Needs property lines and road widths." },
];

export function ruleById(id: string): PermitRule {
  const r = PERMIT_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`no permit rule ${id}`);
  return r;
}
