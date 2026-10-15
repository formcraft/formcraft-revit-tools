import { z } from "zod";

/**
 * Line diagrams (track LD, docs/PLAN_LINE_DIAGRAMS.md): the contract between the Revit side and the server.
 *
 *   fmc_diagram_scan (C#, read-only)  -> SCAN_RESULT : what the model holds, as one graph per diagram
 *   layout (server, pure, tested)     -> DRAW_SPEC   : views of symbols, lines and text in paper mm
 *   fmc_diagram_draw (C#, dry run first) <- DRAW_SPEC : drafting views; every item keeps its source element id
 *
 * Rule 5: values come only from the model. A missing value is null, the layout prints TBC, and the scan lists it in gaps.
 */

export const DIAGRAM_KINDS = [
  "e_sld",          // electrical single-line: supply, boards, feeders, circuits (BS 7671 practice, IEC 60617 symbols)
  "e_fa_riser",     // fire alarm riser / zone chart (BS 5839)
  "e_elv_riser",    // data, CCTV, access, intercom, electric fence
  "fp_schematic",   // fire-fighting: pumps, tanks, valves, risers, hose reels, sprinklers (BS EN 12845)
  "p_water",        // domestic cold and hot water: tanks, pumps, risers, fixtures per level
  "p_drainage",     // soil, waste and rainwater stacks per level
  "m_refrigerant",  // outdoor-indoor pairing, refrigerant and condensate
  "lp_schematic",   // air terminations, down conductors, test joints, earth pits, bonds (BS EN 62305)
] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export const NODE_KINDS = [
  "supply", "board", "load", "device", "panel", "equipment", "pump", "tank", "valve", "meter", "fixture", "sprinkler",
  "hose_reel", "hydrant", "inlet", "riser", "stack", "indoor_unit", "outdoor_unit", "air_terminal", "down_conductor",
  "test_joint", "earth_pit", "earth_bar", "spd", "bond", "other",
] as const;
export const EDGE_KINDS = ["feeder", "circuit", "pipe", "duct", "conductor", "loop", "refrigerant", "condensate", "data", "bond"] as const;

const value = z.union([z.string(), z.number(), z.null()]);

export const SCAN_NODE = z.object({
  id: z.string().describe("Revit element id (UniqueId when it has one), or a synthetic id such as supply:MDB"),
  kind: z.enum(NODE_KINDS),
  name: z.string().default(""),
  category: z.string().default(""),
  family: z.string().default(""),
  type: z.string().default(""),
  level: z.string().nullable().default(null).describe("level id from levels[], null when the element has none"),
  params: z.record(value).default({}).describe("model values: panel id, way, rating, poles, cable, load, size, system, zone, loop…"),
});
export const SCAN_EDGE = z.object({
  from: z.string(), to: z.string(),
  kind: z.enum(EDGE_KINDS),
  params: z.record(value).default({}).describe("circuit number, rating, poles, cable, apparent load; pipe size, system…"),
});
export const SCAN_DIAGRAM = z.object({
  kind: z.enum(DIAGRAM_KINDS),
  system: z.string().describe("what this diagram covers, e.g. the board name or the piping system name"),
  nodes: z.array(SCAN_NODE),
  edges: z.array(SCAN_EDGE),
});
export const SCAN_RESULT = z.object({
  model: z.string(),
  levels: z.array(z.object({ id: z.string(), name: z.string(), elevation_mm: z.number() })),
  diagrams: z.array(SCAN_DIAGRAM),
  gaps: z.array(z.object({ kind: z.enum(DIAGRAM_KINDS), element_id: z.string().nullable().default(null), message: z.string() })),
});
export type ScanNode = z.infer<typeof SCAN_NODE>;
export type ScanEdge = z.infer<typeof SCAN_EDGE>;
export type ScanDiagram = z.infer<typeof SCAN_DIAGRAM>;
export type ScanResult = z.infer<typeof SCAN_RESULT>;

const xy = z.array(z.number().finite()).length(2).describe("[x, y] in paper mm from the view's origin, y up");

export const DRAW_ITEM = z.discriminatedUnion("t", [
  z.object({ t: z.literal("symbol"), family: z.string().min(1), type: z.string().min(1), at: xy, rotation_deg: z.number().default(0),
    source_id: z.string().nullable().default(null), params: z.record(z.string()).default({}).describe("instance parameters to set (labels)") }),
  z.object({ t: z.literal("line"), points: z.array(xy).min(2), style: z.string().min(1).describe("a line style in the project, e.g. FMC_Thin"),
    source_id: z.string().nullable().default(null) }),
  z.object({ t: z.literal("text"), at: xy, text: z.string(), style: z.string().min(1).describe("a text type, e.g. FMC_Arial_2.5"),
    align: z.enum(["left", "center", "right"]).default("left"), source_id: z.string().nullable().default(null) }),
]);
export const DRAW_VIEW = z.object({
  name: z.string().min(1).describe("drafting view name, e.g. E-SLD-MDB"),
  kind: z.enum(DIAGRAM_KINDS),
  scale: z.number().int().positive().default(50).describe("view scale; paper mm × scale = model mm"),
  sheet_hint: z.string().nullable().default(null).describe("Sheet Register number this view belongs on, when known"),
  items: z.array(DRAW_ITEM),
});
export const DRAW_SPEC = z.object({ views: z.array(DRAW_VIEW).min(1), dry_run: z.boolean().default(true) });
export type DrawItem = z.infer<typeof DRAW_ITEM>;
export type DrawView = z.infer<typeof DRAW_VIEW>;
export type DrawSpec = z.infer<typeof DRAW_SPEC>;

/** What fmc_diagram_draw answers. */
export const DRAW_RESULT = z.object({
  dry_run: z.boolean(),
  views: z.array(z.object({ name: z.string(), result: z.enum(["create", "update", "skip"]), view_id: z.string().nullable(),
    symbols: z.number(), lines: z.number(), texts: z.number(), kept_by_hand: z.number().describe("items a person added, left in place") })),
  warnings: z.array(z.string()),
});
