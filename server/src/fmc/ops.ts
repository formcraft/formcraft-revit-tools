/**
 * fmc_doc ops (docs/PLAN_B1_ENGINE.md, B1b): the fixed vocabulary a builder sends, validated before Revit sees it.
 * Every op names what it makes, so a batch is idempotent: Revit answers create, update or skip per op. Sizes are mm.
 * Shared parameters come only from the kit's dictionary, by GUID (rule 7). The only delete is delete_template_element:
 * elements the family template ships, matched by kind, category, subcategory or name (never an id), never one an op
 * made, in the background family document being built. Files are never deleted.
 */
import { BUILTIN_PARAMS, OPENING_PARAMS, geometryProblems, isOpeningTemplate } from "./opsgeom.js";
import path from "node:path";
import { z } from "zod";
import { isInside } from "./policy.js";
import { SpParam } from "./specs.js";
import { MaterialDb } from "./materials.js";

const mm = z.number().finite();
// Fixed-length arrays, not z.tuple: a tuple becomes JSON Schema "items": [a, b], which the Claude API rejects
// ("items must be object,boolean"), and the whole tool drops out of the client. schemas.test.ts checks every tool.
const point = z.array(mm).length(2).describe("[x, y] in mm");
const point3 = z.array(mm).length(3).describe("[x, y, z] in mm");
const VIEWS = ["plan", "front", "right"] as const;
// A point as the crossing of two named reference planes: an end drawn there is locked to both, so it follows them.
const planeEnd = z.object({ planes: z.array(z.string().min(1)).length(2)
  .describe("two reference planes that cross in the view (in plan: a left/right plane and a front/back plane); {k} is the leaf number in a repeat") });
const end = z.union([point, planeEnd]);
const visibility = {
  coarse: z.boolean().optional(), medium: z.boolean().optional(), fine: z.boolean().optional(),
};
// A corner of a parametric sweep path: where two named reference planes (or a level, such as Ref. Level) cross in the
// path plane view. Two names, an array with .length(2), never z.tuple (see point).
const corner = z.array(z.string().min(1)).length(2).describe("[plane, plane]: where two named reference planes (or a level) cross");
const segmentOffset = z.union([mm, z.string().min(1)])
  .describe("mm, or a Length parameter's name (\"-Name\" for the other way): the segment sits this far off the plane it runs along");
const sweepShape = {
  name: z.string().min(1),
  path: z.array(point).min(2).optional().describe("a fixed polyline in mm in the path plane: it never follows a parameter (use path_planes)"),
  path_planes: z.array(corner).min(2).optional().describe(
    "the parametric path: corners in order, each the crossing of two named planes, e.g. [[\"Left\",\"Sill\"],[\"Left\",\"Head\"]," +
    "[\"Right\",\"Head\"],[\"Right\",\"Sill\"]]. Neighbouring corners share exactly one plane (the segment runs along it); each " +
    "segment is locked to its plane and each open end to its other plane, so the sweep follows them. A lock Revit can't make fails the op"),
  path_offsets: z.array(segmentOffset).optional().describe(
    "path_planes: one per segment (corners - 1). Positive is +x (plan: +x or +y) across a segment that runs along a vertical " +
    "plane, and up (plan: +y or +x) off one that runs along a horizontal plane; a mm offset is a locked dimension, a parameter a labelled one"),
  path_host: z.string().min(1).optional().describe(
    "path_planes: a reference plane parallel to the path plane that hosts the path sketch, so the sweep follows it (e.g. Frame Ext); otherwise the path sits at `at`"),
  path_plane: z.enum(VIEWS).default("plan").describe("plan: [x, y] at height `at`; front: [x, z] at y = `at`; right: [y, z] at x = `at`"),
  at: mm.default(0),
  profile: z.array(point).min(3).optional().describe("a closed profile in mm, local to the start of the path (x across, y up)"),
  profile_family: z.string().optional().describe("or a loaded profile family (FMC_Profile_*), loaded earlier with load_family"),
  profile_type: z.string().optional(),
  subcategory: z.string().optional(),
};

export const DATA_TYPES = ["Length", "Number", "Integer", "YesNo", "Text", "Material", "Area", "Volume", "Angle",
  "Voltage", "ApparentPower", "NumberOfPoles", "PipeSize", "Flow", "LoadClassification"] as const;
export const CONNECTOR_PARAMS = ["Diameter", "Radius", "Width", "Height", "Voltage", "Number of Poles", "Apparent Load", "Power Factor",
  "Load Classification", "Pipe Flow", "Duct Flow"] as const;
export const GROUPS = ["Dimensions", "Constraints", "Data", "Text", "Materials", "IdentityData", "Graphics", "Electrical", "ElectricalLoads",
  "Mechanical", "Plumbing", "General"] as const;
export const REFERENCES = ["NotAReference", "WeakReference", "StrongReference", "Left", "CenterLeftRight", "Right", "Front", "CenterFrontBack",
  "Back", "Bottom", "CenterElevation", "Top"] as const;

export const OP = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_category"), name: z.string().min(1).describe("Revit category name, e.g. Generic Models, or OST_ name") }),
  z.object({ op: z.literal("set_family_params"), name: z.literal("family"), work_plane_based: z.boolean().optional(),
    always_vertical: z.boolean().optional(), shared: z.boolean().optional(), room_calculation_point: z.boolean().optional() }),
  z.object({ op: z.literal("add_ref_plane"), name: z.string().min(1), from: point, to: point,
    view: z.string().optional().describe("the view to draw in (default: Ref. Level). In plan, from/to are [x, y]; in an elevation (e.g. Front), [across, up], so level planes such as Head or Sill can be drawn"),
    is_reference: z.enum(REFERENCES).optional() }),
  z.object({ op: z.literal("add_family_param"), name: z.string().min(1), type: z.enum(DATA_TYPES), instance: z.boolean().default(false),
    group: z.enum(GROUPS).default("Dimensions") }),
  z.object({ op: z.literal("add_shared_param"), name: z.string().min(1), guid: z.string().min(1), instance: z.boolean().default(false),
    group: z.enum(GROUPS).default("Data") }),
  z.object({ op: z.literal("set_formula"), name: z.string().min(1).describe("the parameter"), formula: z.string() }),
  z.object({ op: z.literal("add_type"), name: z.string().min(1) }),
  z.object({ op: z.literal("set_type_value"), name: z.string().min(1).describe("<type>/<parameter>"), type: z.string().min(1),
    param: z.string().min(1), value: z.union([z.number(), z.string(), z.boolean()]).describe("Length and pipe size in mm, Angle in degrees, Voltage in V, apparent power in VA, flow in L/s") }),
  z.object({ op: z.literal("add_dimension"), name: z.string().min(1).describe("identity: usually the label, e.g. Width"),
    between: z.array(z.string().min(1)).length(2).describe("two reference planes by name"),
    view: z.string().optional(), label: z.string().optional().describe("a family parameter that drives the dimension"),
    offset: mm.default(300).describe("where the dimension line sits, mm from the first plane") }),
  z.object({ op: z.literal("extrusion"), name: z.string().min(1),
    rect: z.array(z.string().min(1)).length(4).optional().describe("left, right, front, back reference planes; each side is locked to its plane"),
    points: z.array(point).min(3).optional().describe("or a closed outline in mm (not locked)"),
    start: mm.default(0), end: mm.default(1000), start_plane: z.string().optional().describe("a plane or level the bottom goes onto and is locked to (the start moves onto it first, F-064)"),
    end_plane: z.string().optional().describe("a level reference plane, or a level such as Upper Ref. Level, the top goes onto and is locked to (the end moves onto it first)"),
    view: z.string().optional(),
    sketch: z.enum(["plan", "front", "right"]).optional().describe("plan (default): points [x, y], depth up; front: [x, z], depth toward the viewer (-y); right: [y, z], depth along +x (F-059)") }),
  z.object({ op: z.literal("void_extrusion"), name: z.string().min(1),
    rect: z.array(z.string().min(1)).length(4).optional().describe("left, right, front, back reference planes; each side is locked to its plane"),
    points: z.array(point).min(3).optional().describe("or a closed outline in mm (not locked)"),
    start: mm.default(0), end: mm.default(1000), start_plane: z.string().optional().describe("a plane or level the bottom goes onto and is locked to"),
    end_plane: z.string().optional().describe("a level reference plane, or a level, the top goes onto and is locked to"),
    view: z.string().optional(),
    sketch: z.enum(["plan", "front", "right"]).optional().describe("plan (default): points [x, y], depth up; front: [x, z], depth toward the viewer (-y); right: [y, z], depth along +x (F-059)") }),
  z.object({ op: z.literal("set_material_param"), name: z.string().min(1).describe("the solid"), param: z.string().min(1) }),
  z.object({ op: z.literal("add_connector"), name: z.string().min(1), domain: z.enum(["electrical", "pipe", "duct"]),
    system: z.string().min(1).describe("e.g. Domestic Cold Water, PowerUnBalanced, SupplyAir"), solid: z.string().min(1),
    side: z.enum(["left", "right", "front", "back", "top", "bottom"]).default("top"),
    flow: z.enum(["In", "Out", "Bidirectional"]).optional(), diameter: mm.positive().optional(), width: mm.positive().optional(), height: mm.positive().optional() }),
  z.object({ op: z.literal("link_connector_param"), name: z.string().min(1).describe("<connector>/<connector parameter>"),
    connector: z.string().min(1), connector_param: z.enum(CONNECTOR_PARAMS), param: z.string().min(1) }),
  z.object({ op: z.literal("set_visibility"), name: z.string().min(1).describe("the solid"), coarse: z.boolean().optional(), medium: z.boolean().optional(),
    fine: z.boolean().optional(), plan_rcp: z.boolean().optional(), front_back: z.boolean().optional(), left_right: z.boolean().optional() }),  // LOD 400 pack (Family Authoring Standard 1-3): object subcategories, swept/revolved/blended solids, symbolic lines,
  // face locks, equal dimensions, nested families.
  z.object({ op: z.literal("add_subcategory"), name: z.string().min(1).describe("e.g. Frame, Panel, Glass, Plan Swing, Elevation Swing, Clearance"),
    line_weight_projection: z.number().int().min(1).max(16).optional(), line_weight_cut: z.number().int().min(1).max(16).optional(),
    color: z.array(z.number().int().min(0).max(255)).length(3).optional().describe("[r, g, b]"),
    material: z.string().optional().describe("an FMC_ material already in the family") }),
  z.object({ op: z.literal("set_subcategory"), name: z.string().min(1).describe("the solid or line set, by op name"),
    subcategory: z.string().min(1) }),
  z.object({ op: z.literal("sweep"), ...sweepShape }),
  z.object({ op: z.literal("void_sweep"), ...sweepShape }),
  z.object({ op: z.literal("revolution"), name: z.string().min(1),
    profile: z.array(point).min(3).describe("closed profile as [r, z] in mm: distance from the axis, height"),
    axis_at: point.default([0, 0]).describe("axis z: [x, y] in plan; axis y: [x, z]; axis x: [y, z] (mm)"),
    axis: z.enum(["z", "y", "x"]).optional().describe("z (default, vertical); y: faces the viewer, profile [r, depth toward -y]; x: profile [r, depth along +x] (knobs, ports, nozzles, LEDs)"),
    start_deg: z.number().default(0), end_deg: z.number().default(360), subcategory: z.string().optional() }),
  z.object({ op: z.literal("blend"), name: z.string().min(1),
    base: z.array(point).min(3).describe("closed base outline in plan, mm"), top: z.array(point).min(3).describe("closed top outline in plan, mm"),
    start: mm.default(0), end: mm.default(1000), subcategory: z.string().optional() }),
  z.object({ op: z.literal("symbolic_lines"), name: z.string().min(1).describe("one name for the set, e.g. Swing plan"),
    view: z.enum(VIEWS).default("plan").describe("plan lines show in plan views; front in front/back elevations; right in side elevations"),
    at: mm.default(0),
    points: z.array(point).min(2).optional().describe("a polyline in the view's plane, mm (fixed: it doesn't follow parameters)"),
    lines: z.array(z.object({ from: end, to: end })).min(1).optional()
      .describe("parametric lines: each end is [x, y] in mm or {planes: [a, b]}; an end on planes is locked to them and a line whose ends share a plane is locked to it, so plan swings and fold symbols follow Width and the leaf planes"),
    arc: z.object({ center: end, radius: mm.positive().describe("mm, as drawn"),
      radius_param: z.string().optional().describe("a Length parameter that drives the radius (a radial dimension labelled with it), e.g. Leaf Width"),
      start_deg: z.number(), end_deg: z.number() }).optional()
      .describe("or an arc, e.g. a door swing; its center can be {planes: [a, b]} (locked there)"),
    show_if: z.string().optional().describe("a Yes/No formula: the lines show only when it is true, e.g. Leaf Count > 1"),
    repeat: z.object({ count_param: z.string().min(1).describe("an Integer parameter, e.g. Leaf Count"),
      max: z.number().int().min(2).max(12).describe("how many sets are drawn; the ones above the count are hidden") }).optional()
      .describe("per-leaf repeats: the set is drawn for k = 1..max with {k} in plane names replaced by k, and set k shows when count_param > k - 1"),
    subcategory: z.string().min(1).describe("Plan Swing, Elevation Swing, Hidden Lines…"), ...visibility }),
  z.object({ op: z.literal("name_template_plane"), name: z.string().min(1).describe("the name to give it"),
    axis: z.enum(["x", "y", "z"]).describe("the axis the plane is square to: x for a plane across Left/Right, z for a level plane"),
    at_mm: z.number().describe("where it is along that axis, mm"), tolerance_mm: z.number().positive().optional() }),
  z.object({ op: z.literal("skeleton"), name: z.string().min(1),
    width: z.object({ param: z.string().min(1), mm: z.number().positive() }), depth: z.object({ param: z.string().min(1), mm: z.number().positive() }),
    height: z.object({ param: z.string().min(1), mm: z.number().positive() }),
    mounting: z.object({ param: z.string().min(1), mm: z.number().min(0) }).optional().describe("an instance height of the bottom above the base"),
    base: z.string().optional().describe("the level plane height starts from (default Ref. Level)"),
    planes: z.object({ left: z.string(), right: z.string(), front: z.string(), back: z.string(), bottom: z.string(), top: z.string() }).partial().optional(),
    type: z.string().optional().describe("the type the default size goes to") }),
  z.object({ op: z.literal("lock_face"), name: z.string().min(1).describe("<solid>/<plane>"), solid: z.string().min(1), plane: z.string().min(1),
    view: z.enum(VIEWS).default("plan").describe("plan for vertical planes, front for level planes") }),
  z.object({ op: z.literal("add_eq_dimension"), name: z.string().min(1), planes: z.array(z.string().min(1)).min(3)
    .describe("three or more reference planes in order, e.g. Left, Center (Left/Right), Right"),
    view: z.string().optional(), offset: mm.default(600) }),
  z.object({ op: z.literal("load_family"), name: z.string().min(1).describe("the family name once loaded"),
    path: z.string().min(1).describe("an .rfa relative to the kit's family staging root (e.g. _Profiles\\FMC_Profile_Architrave_Contemporary.rfa), " +
      "found there, in 04_Families or a library root on this PC; an absolute path must be inside those roots"),
    shared: z.boolean().optional().describe("true for a shared nested family (handles, hinges, locks) that schedules on its own: the load checks the family is shared") }),
  z.object({ op: z.literal("place_nested"), name: z.string().min(1), family: z.string().min(1), type: z.string().min(1),
    at: point3.default([0, 0, 0]), rotate_deg: z.number().default(0),
    params: z.record(z.string()).default({}).describe("nested instance parameter → this family's parameter (associated)") }),
  // Profiles, switches and kit materials (FAM-040): profile families drawn as data, a Yes/No parameter that shows or
  // hides a solid, and materials made from the kit's library with their textures.
  z.object({ op: z.literal("profile_lines"), name: z.string().min(1).describe("one name for the loop"),
    start: point.describe("[x, y] in mm in the profile family's Ref. Level plan: x across, y up"),
    segments: z.array(z.object({ to: point, through: point.optional().describe("a point on the arc: the segment is a 3-point arc") }))
      .min(1).describe("each segment runs from the previous point to `to`; the last `to` must equal start (a closed loop)"),
    subcategory: z.string().optional() }),
  z.object({ op: z.literal("set_visible_param"), name: z.string().min(1).describe("<solid>/Visible"), solid: z.string().min(1),
    param: z.string().min(1).describe("a Yes/No family parameter, e.g. one with a formula such as FMC_Design_Movement = 7") }),
  z.object({ op: z.literal("add_material"), name: z.string().min(1).describe("an FMC_ material in the kit's 07_Materials\\FMC_Materials.json"),
    param: z.string().optional().describe("a Material family parameter whose value becomes this material in every type") }),
  // Recipe ops from the Ogala field review (run 9): arrays tied to a count, template clean-up, the default size first.
  z.object({ op: z.literal("array"), name: z.string().min(1).describe("the array, e.g. Louvre blades"),
    solid: z.string().min(1).describe("the solid to repeat (by op name); it is member 1"),
    direction: z.enum(["x", "y", "z"]).describe("x across, y front/back, z up"),
    count_param: z.string().min(1).describe("an Integer family parameter: how many show"),
    mode: z.enum(["copies", "linear"]).default("copies")
      .describe("copies (default, reliable): max - 1 copies at spacing_mm named \"<solid> #k\", member k shows when count_param > k - 1; linear: Revit's LinearArray with its count labelled count_param (to be confirmed in Revit)"),
    max: z.number().int().min(2).max(50).default(12).describe("copies: how many members are made (the most the count can show)"),
    spacing_mm: mm.optional().describe("the step between members in mm (negative goes the other way)"),
    spacing_param: z.string().optional().describe("linear only: a Length parameter that drives the step"),
    between: z.array(z.string().min(1)).length(2).optional()
      .describe("linear only: [first, last] reference planes; the members spread between them (the solid lies on the first)") }),
  z.object({ op: z.literal("delete_template_element"), name: z.string().min(1).describe("what goes, e.g. Template frame"),
    kind: z.enum(["solid", "void", "symbolic_line", "model_line", "detail_line", "nested_family", "opening", "any"]).default("any"),
    category: z.string().optional().describe("the element's category, e.g. Doors or OST_Doors"),
    subcategory: z.string().optional().describe("e.g. Frame/Mullion, Panel, Plan Swing, Elevation Swing"),
    element_name: z.string().optional().describe("the element's name in Revit (Extrusion, a nested family's name)"),
    max: z.number().int().min(1).max(50).default(10).describe("refuse when more than this match") }),
  z.object({ op: z.literal("set_default_size"), name: z.string().min(1).describe("identity, e.g. Default size"),
    type: z.string().optional().describe("the type to make current (made when missing); default: the template's current type"),
    values: z.record(mm.positive()).describe("Length parameter → mm, e.g. { \"Width\": 900, \"Height\": 2100 }") }),
  // Owner, 17 Oct: the product picture as Revit's built-in Type Image (Type Properties, schedules, legends).
  z.object({ op: z.literal("set_type_image"), name: z.string().min(1).describe("identity, e.g. Type image"),
    path: z.string().min(1).describe("a .png or .jpg in the kit's families folder, e.g. 04_Families\\_Staging\\<Role>\\_Images\\<family>.png"),
    type: z.string().optional().describe("one type; default: every type") }),
]);
export type Op = z.infer<typeof OP>;
export const OPS = z.array(OP).min(1).max(500);

type SkeletonOp = Extract<Op, { op: "skeleton" }>;

/**
 * F-062 #3: a skeleton op becomes the ops it stands for: Width, Depth and Height parameters, the default size first
 * (F-026), Left/Right and Front/Back planes with labelled dimensions and an equality about the centre planes, a Top
 * plane (and a Bottom one at an instance mounting height), each labelled. Every other op passes through.
 */
export function expandSkeletons<T extends { op: string }>(ops: T[]): T[] {
  return ops.flatMap((o) => (o.op === "skeleton" ? (skeletonOps(o as unknown as SkeletonOp) as unknown as T[]) : [o]));
}

function skeletonOps(s: SkeletonOp): Array<Record<string, unknown>> {
  const n = { left: "Left", right: "Right", front: "Front", back: "Back", bottom: "Bottom", top: "Top", ...(s.planes ?? {}) };
  const base = s.base ?? "Ref. Level";
  const w = s.width.mm / 2, d = s.depth.mm / 2, m = s.mounting?.mm ?? 0, h = s.height.mm;
  const far = 3000;
  const out: Array<Record<string, unknown>> = [];
  for (const p of [s.width, s.depth, s.height]) out.push({ op: "add_family_param", name: p.param, type: "Length", instance: false, group: "Dimensions" });
  if (s.mounting) out.push({ op: "add_family_param", name: s.mounting.param, type: "Length", instance: true, group: "Dimensions" });
  out.push({ op: "set_default_size", name: `${s.name} size`, values: { [s.width.param]: s.width.mm, [s.depth.param]: s.depth.mm, [s.height.param]: s.height.mm },
    ...(s.type ? { type: s.type } : {}) });
  out.push({ op: "add_ref_plane", name: n.left, from: [-w, -far], to: [-w, far] }, { op: "add_ref_plane", name: n.right, from: [w, -far], to: [w, far] },
    { op: "add_ref_plane", name: n.front, from: [-far, -d], to: [far, -d] }, { op: "add_ref_plane", name: n.back, from: [-far, d], to: [far, d] });
  out.push({ op: "add_dimension", name: s.width.param, between: [n.left, n.right], label: s.width.param, offset: 300 },
    { op: "add_eq_dimension", name: `${s.name} EQ width`, planes: [n.left, "Center (Left/Right)", n.right], offset: 600 },
    { op: "add_dimension", name: s.depth.param, between: [n.front, n.back], label: s.depth.param, offset: 300 },
    { op: "add_eq_dimension", name: `${s.name} EQ depth`, planes: [n.front, "Center (Front/Back)", n.back], offset: 600 });
  let bottom = base;
  if (s.mounting) {
    out.push({ op: "add_ref_plane", name: n.bottom, from: [-far, m], to: [far, m], view: "Front" },
      { op: "add_dimension", name: s.mounting.param, between: [base, n.bottom], label: s.mounting.param, view: "Front", offset: 300 });
    bottom = n.bottom;
  }
  out.push({ op: "add_ref_plane", name: n.top, from: [-far, m + h], to: [far, m + h], view: "Front" },
    { op: "add_dimension", name: s.height.param, between: [bottom, n.top], label: s.height.param, view: "Front", offset: 300 });
  return out;
}

// ---- profile loops ----------------------------------------------------------------------------------------------------

type P2 = [number, number];
const TOL = 0.01; // mm: closer than this is the same point
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** The points along a 3-point arc from a through m to b (16 pieces), or null when the three points are in a line. */
function arcPoints(a: P2, m: P2, b: P2): P2[] | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  const scale = Math.max(dist(a, m), dist(m, b), dist(a, b));
  if (Math.abs(cross(a, m, b)) < 1e-9 * scale * scale || d === 0) return null;
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  const ang = (p: P2) => Math.atan2(p[1] - cy, p[0] - cx);
  const ccw = (from: number, to: number) => { let s = to - from; while (s < 0) s += 2 * Math.PI; while (s >= 2 * Math.PI) s -= 2 * Math.PI; return s; };
  const a0 = ang(a), toM = ccw(a0, ang(m)), toB = ccw(a0, ang(b));
  // Counter-clockwise from a reaches m before b: the arc runs counter-clockwise; otherwise clockwise.
  const sweep = toM < toB ? toB : toB - 2 * Math.PI;
  const out: P2[] = [];
  for (let k = 1; k <= 16; k++) { const t = a0 + (sweep * k) / 16; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  out[out.length - 1] = b;
  return out;
}

/** Proper or touching intersection of segments p1-p2 and q1-q2 (shared end points count as touching). */
function segmentsMeet(p1: P2, p2: P2, q1: P2, q2: P2): boolean {
  const eps = 1e-9;
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  const on = (a: P2, b: P2, c: P2) => Math.abs(cross(a, b, c)) <= eps * Math.max(1, dist(a, b)) &&
    Math.min(a[0], b[0]) - TOL <= c[0] && c[0] <= Math.max(a[0], b[0]) + TOL && Math.min(a[1], b[1]) - TOL <= c[1] && c[1] <= Math.max(a[1], b[1]) + TOL;
  return on(q1, q2, p1) || on(q1, q2, p2) || on(p1, p2, q1) || on(p1, p2, q2);
}

/**
 * A profile loop Revit accepts: closed (the last point is the start, within 0.01 mm), no zero-length segment, no arc
 * whose three points are in a line, no crossing or touching of itself, and some area. Arcs are checked as 16 short
 * pieces, which is close enough to catch a loop that crosses itself.
 */
export function profileLoopProblems(start: number[], segments: Array<{ to: number[]; through?: number[] }>): string[] {
  const p: string[] = [];
  const flat: P2[] = [[start[0], start[1]]];
  let from: P2 = [start[0], start[1]];
  segments.forEach((s, k) => {
    const to: P2 = [s.to[0], s.to[1]];
    if (dist(from, to) < TOL) p.push(`segment ${k + 1} has no length`);
    if (s.through) {
      const m: P2 = [s.through[0], s.through[1]];
      const pts = dist(from, m) < TOL || dist(m, to) < TOL ? null : arcPoints(from, m, to);
      if (!pts) p.push(`segment ${k + 1}: the arc's through point is on its ends or in line with them (use a line, or move the point)`);
      else flat.push(...pts);
    } else flat.push(to);
    from = to;
  });
  if (dist(from, [start[0], start[1]]) >= TOL) {
    p.push(`the loop isn't closed: it ends at [${from.join(", ")}], not at the start [${start.join(", ")}]`);
    return p;
  }
  if (p.length) return p;
  flat.pop(); // the last point is the start again
  const n = flat.length;
  for (let i = 0; i < n && p.length === 0; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours across the start
      if (segmentsMeet(flat[i], flat[(i + 1) % n], flat[j], flat[(j + 1) % n])) { p.push("the loop crosses or touches itself"); break; }
    }
  if (p.length) return p;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = flat[i], b = flat[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  if (n < 3 || Math.abs(area) / 2 < 1e-6) p.push("the loop encloses no area");
  return p;
}

// ---- parametric sweep paths -------------------------------------------------------------------------------------------

type SweepOp = Extract<Op, { op: "sweep" | "void_sweep" }>;

/**
 * path_planes: neighbouring corners share exactly one plane (the one the segment runs along), a corner names two
 * different planes, path_offsets has one entry per segment, two segments in a row along the same plane keep the same
 * offset, and a parameter offset is a Length parameter.
 */
export function pathPlaneProblems(o: SweepOp, params: Set<string>, paramTypes: Map<string, string>): string[] {
  const p: string[] = [];
  const c = o.path_planes ?? [];
  const label = (k: number) => `[${c[k].join(", ")}]`;
  c.forEach((pair, k) => { if (pair[0] === pair[1]) p.push(`corner ${k + 1} ${label(k)} names one plane twice`); });
  const along = runningPlanes(c);
  along.forEach((pl, k) => {
    if (pl === null) p.push(`segment ${k + 1} from ${label(k)} to ${label(k + 1)} doesn't run along one plane: neighbouring corners share exactly one plane`);
  });
  const offs = o.path_offsets;
  if (offs) {
    if (offs.length !== c.length - 1) p.push(`path_offsets has ${offs.length} entries for ${c.length - 1} segments (one per segment)`);
    offs.forEach((x, k) => {
      if (typeof x !== "string") return;
      const name = x.replace(/^-/, "").trim();
      if (!params.has(name)) p.push(`segment ${k + 1}'s offset parameter "${name}" isn't added earlier in this batch (it may exist in the file: then it's fine)`);
      else if (paramTypes.has(name) && paramTypes.get(name) !== "Length") p.push(`segment ${k + 1}'s offset "${name}" is ${paramTypes.get(name)}: an offset takes a Length parameter`);
    });
    for (let k = 1; k < along.length; k++)
      if (along[k] !== null && along[k] === along[k - 1] && String(offs[k] ?? 0) !== String(offs[k - 1] ?? 0))
        p.push(`segments ${k} and ${k + 1} both run along ${along[k]} with different offsets: they can't meet`);
  }
  return p;
}

/** The plane each segment of a path_planes path runs along (the one plane its two corners share), or null. */
export function runningPlanes(corners: string[][]): Array<string | null> {
  const out: Array<string | null> = [];
  for (let k = 0; k + 1 < corners.length; k++) {
    const shared = corners[k].filter((x) => corners[k + 1].includes(x));
    out.push(shared.length === 1 ? shared[0] : null);
  }
  return out;
}

const isAbsolutePath = (p: string) => /^[A-Za-z]:\\/.test(p) || p.startsWith("\\");
const relativeHint = (file: string) => {
  const parts = file.split("\\").filter(Boolean);
  const i = parts.findIndex((s) => /^_Profiles$/i.test(s));
  return i >= 0 ? parts.slice(i).join("\\") : parts[parts.length - 1];
};

/**
 * A load_family path as Revit gets it: a relative path is joined to the first root that holds the file (the family
 * staging root, then 04_Families, then the library roots), or to the staging root when none does (Revit then says
 * "No file …" naming the full path). An absolute path is passed on as it is.
 */
export function resolveFamilyPath(file: string, roots: string[], exists: (f: string) => boolean): { path: string; found: boolean; root: string } {
  const f = file.replace(/\//g, "\\");
  if (isAbsolutePath(f) || !roots.length) return { path: f, found: exists(f), root: "" };
  for (const r of roots) {
    const full = path.win32.join(r, f);
    if (exists(full)) return { path: full, found: true, root: r };
  }
  return { path: path.win32.join(roots[0], f), found: false, root: roots[0] };
}

/** Every load_family op with its path resolved; notes for the ones not found on this PC. */
export function resolveFamilyPaths<T extends { op: string; name: string }>(ops: T[], roots: string[], exists: (f: string) => boolean): { ops: T[]; notes: string[] } {
  const notes: string[] = [];
  const out = ops.map((o) => {
    const given = (o as { path?: unknown }).path;
    if (o.op !== "load_family" || typeof given !== "string" || !given) return o;
    const r = resolveFamilyPath(given, roots, exists);
    if (!r.found) notes.push(`load_family ${o.name}: ${r.path} isn't on this PC${isAbsolutePath(given.replace(/\//g, "\\")) ? "" : ` (looked in ${roots.join(", ")})`}: build the profile first`);
    return r.path === given ? o : { ...o, path: r.path };
  });
  return { ops: out, notes };
}

/** The family roots a relative load_family path is read against, in order: staging root, 04_Families, library roots. */
export function familyRoots(stagingRoot: string, libraryRoots: string[] = []): string[] {
  const s = stagingRoot.replace(/[\\/]+$/, "");
  const all = [s, path.win32.dirname(s), ...libraryRoots.filter((r) => !r.includes("*")).map((r) => r.replace(/[\\/]+$/, ""))];
  return [...new Set(all.filter(Boolean))];
}

export interface OpsCheckOptions {
  /** The guard's library roots: an absolute load_family path may also sit in one of these. */
  libraryRoots?: string[];
  /** The template's own planes (recipe check and build): a path_planes plane that is neither made earlier nor one of these is an error. */
  templatePlanes?: string[];
  /** The recipe's template (recipe check and build): a parameter a type sets must be added or one the template has (F-064). */
  template?: string;
}
/** Marks a problem that is passed on as a note, not an error. */
export const WARNING = "warning:";
/** The size parameters a door or window template ships (they exist in the file before any op). */
const TEMPLATE_SIZE_PARAMS = new Set(["Width", "Height"]);
const SIZE_PARAMS = TEMPLATE_SIZE_PARAMS;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

const sharedType = (datatype: string) => (/^YESNO$/i.test(datatype) ? "YesNo" : /^MATERIAL$/i.test(datatype) ? "Material" : datatype);

/**
 * Checks the batch as a whole: unique names per op kind, shared parameters from the dictionary, references made earlier.
 * materials is the kit's material library: null when it isn't readable (add_material is then refused), left out when
 * the caller has no kit (tests), and add_material isn't checked against it.
 */
export function opsProblems(ops: Op[], dictionary: Map<string, SpParam> | null, familiesRoot?: string, materials?: MaterialDb | null,
  opts: OpsCheckOptions = {}): string[] {
  ops = expandSkeletons(ops);
  const p: string[] = [];
  const seen = new Set<string>();
  const paramTypes = new Map<string, string>();
  const solids = new Set<string>(), connectors = new Set<string>(), subcats = new Set<string>(), lines = new Set<string>(), families = new Set<string>();
  const mayExist = (what: string, n: string) => `reference to ${what} "${n}" that isn't made earlier in this batch (it may exist in the file: then it's fine)`;
  const params = new Set<string>(), types = new Set<string>(), planes = new Set<string>(["Center (Left/Right)", "Center (Front/Back)", "Ref. Level"]);
  const typedParam = (want: string) => (n: string, at: string) => {
    if (!params.has(n) && !TEMPLATE_SIZE_PARAMS.has(n)) p.push(`${at}: ${mayExist("parameter", n)}`);
    else if (paramTypes.has(n) && paramTypes.get(n) !== want) p.push(`${at}: "${n}" is ${paramTypes.get(n)}, not ${want}`);
  };
  const integerParam = typedParam("Integer"), lengthParam = typedParam("Length");
  const solidAt = new Map<string, number>();
  const SOLID_OPS = new Set(["extrusion", "void_extrusion", "sweep", "void_sweep", "revolution", "blend"]);
  ops.forEach((o, i) => {
    const at = `op ${i + 1} (${o.op} ${o.name})`;
    const key = `${o.op}|${o.name.toLowerCase()}`;
    if (seen.has(key)) p.push(`${at}: the same ${o.op} name twice in one batch`);
    seen.add(key);
    // F-064: two solids with one name (an extrusion and a sweep, say) fail half way through a build
    if (SOLID_OPS.has(o.op)) {
      const before = solidAt.get(o.name.toLowerCase());
      if (before !== undefined && ops[before].op !== o.op) p.push(`${at}: solid name "${o.name}" is already used by op ${before + 1} (${ops[before].op}): give each solid its own name`);
      solidAt.set(o.name.toLowerCase(), i);
    }
    switch (o.op) {
      case "add_shared_param": {
        // the parameter is added either way, so later ops that use it aren't reported as unknown
        if (!dictionary) { p.push(`${at}: the kit's shared parameter file isn't readable`); params.add(o.name); break; }
        const d = [...dictionary.values()].find((x) => x.guid.toLowerCase() === o.guid.toLowerCase());
        if (!d) p.push(`${at}: GUID ${o.guid} isn't in FMC_SharedParameters.txt (shared parameters come only from the dictionary)`);
        else if (d.name !== o.name) p.push(`${at}: the dictionary names ${o.guid} "${d.name}", not "${o.name}"`);
        if (d) paramTypes.set(o.name, sharedType(d.datatype));
        params.add(o.name);
        break;
      }
      case "add_family_param":
        if (dictionary && [...dictionary.values()].some((x) => x.name === o.name))
          p.push(`${at}: "${o.name}" is a kit shared parameter: add it with add_shared_param and its GUID`);
        paramTypes.set(o.name, o.type);
        params.add(o.name);
        break;
      case "profile_lines":
        for (const x of profileLoopProblems(o.start, o.segments)) p.push(`${at}: ${x}`);
        if (o.subcategory && !subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        lines.add(o.name);
        break;
      case "set_visible_param":
        if (o.name !== `${o.solid}/Visible`) p.push(`${at}: name must be "${o.solid}/Visible"`);
        if (!solids.has(o.solid) && !lines.has(o.solid)) p.push(`${at}: ${mayExist("solid", o.solid)}`);
        if (!params.has(o.param)) p.push(`${at}: ${mayExist("parameter", o.param)}`);
        else if (paramTypes.has(o.param) && paramTypes.get(o.param) !== "YesNo")
          p.push(`${at}: "${o.param}" is ${paramTypes.get(o.param)}: Visible takes a Yes/No parameter`);
        break;
      case "add_material":
        if (materials === null) p.push(`${at}: the kit's material library (07_Materials\\FMC_Materials.json) isn't readable`);
        else if (materials && !materials.materials.some((m) => m.name === o.name))
          p.push(`${at}: "${o.name}" isn't in the kit's material library (07_Materials\\FMC_Materials.json): ask the BIM Manager to add it (fmc_material request)`);
        if (o.param) {
          if (!params.has(o.param)) p.push(`${at}: ${mayExist("parameter", o.param)}`);
          else if (paramTypes.has(o.param) && paramTypes.get(o.param) !== "Material")
            p.push(`${at}: "${o.param}" is ${paramTypes.get(o.param)}: add_material sets a Material parameter`);
        }
        break;
      case "add_type": types.add(o.name); break;
      case "extrusion":
      case "void_extrusion":
        if (!o.rect && !o.points) p.push(`${at}: give rect (four reference planes) or points`);
        if (o.end <= o.start) p.push(`${at}: end (${o.end}) must be above start (${o.start})`);
        for (const pl of [...(o.rect ?? []), ...(o.start_plane ? [o.start_plane] : []), ...(o.end_plane ? [o.end_plane] : [])])
          if (!planes.has(pl)) p.push(`${at}: reference plane "${pl}" isn't made earlier in this batch or a template default (it may exist in the file: then it's fine)`);
        solids.add(o.name);
        break;
      case "add_connector":
        if (!solids.has(o.solid)) p.push(`${at}: solid "${o.solid}" isn't made earlier in this batch (it may exist in the file: then it's fine)`);
        if (o.domain === "duct" && o.width && !o.height) p.push(`${at}: a rectangular duct connector needs width and height`);
        connectors.add(o.name);
        break;
      case "link_connector_param":
        if (o.name !== `${o.connector}/${o.connector_param}`) p.push(`${at}: name must be "${o.connector}/${o.connector_param}"`);
        if (!connectors.has(o.connector)) p.push(`${at}: connector "${o.connector}" isn't made earlier in this batch (it may exist in the file: then it's fine)`);
        if (!params.has(o.param)) p.push(`${at}: parameter "${o.param}" isn't added earlier in this batch (it may exist in the file: then it's fine)`);
        break;
      case "set_material_param":
      case "set_visibility":
        if (!solids.has(o.name)) p.push(`${at}: solid "${o.name}" isn't made earlier in this batch (it may exist in the file: then it's fine)`);
        if (o.op === "set_material_param" && !params.has(o.param)) p.push(`${at}: parameter "${o.param}" isn't added earlier in this batch (it may exist in the file: then it's fine)`);
        break;
      case "add_ref_plane":
        if (o.from[0] === o.to[0] && o.from[1] === o.to[1]) p.push(`${at}: from and to are the same point`);
        planes.add(o.name);
        break;
      case "name_template_plane":
        planes.add(o.name);
        break;
      case "set_type_value":
        if (o.name !== `${o.type}/${o.param}`) p.push(`${at}: name must be "${o.type}/${o.param}"`);
        // F-064: a value for a parameter the batch never adds failed mid-build. Built-ins every family has are fine,
        // and Width/Height/Sill Height on the door and window templates; with the template known, anything else is an error.
        if (!params.has(o.param) && !BUILTIN_PARAMS.has(o.param) && !(OPENING_PARAMS.has(o.param) && (isOpeningTemplate(opts.template) || !opts.template))) {
          if (opts.template) p.push(`${at}: parameter "${o.param}" isn't added in this recipe (add_family_param or add_shared_param) and ${opts.template} doesn't have it`);
          else if (!TEMPLATE_SIZE_PARAMS.has(o.param)) p.push(`${at}: ${mayExist("parameter", o.param)}`);
        }
        break;
      case "add_subcategory": subcats.add(o.name); break;
      case "sweep":
      case "void_sweep":
        if (!o.path && !o.path_planes) p.push(`${at}: give path_planes (corners on named planes) or path (fixed points)`);
        if (o.path && o.path_planes) p.push(`${at}: give path_planes or path, not both`);
        if (o.path_planes) for (const x of pathPlaneProblems(o, params, paramTypes)) p.push(`${at}: ${x}`);
        for (const pl of [...new Set([...(o.path_planes ?? []).flat(), ...(o.path_host ? [o.path_host] : [])])])
          if (!planes.has(pl) && !(opts.templatePlanes ?? []).includes(pl)) p.push(`${at}: ${opts.templatePlanes
            ? `reference plane "${pl}" isn't made earlier in this batch or one of the template's planes (${opts.templatePlanes.join(", ")})`
            : mayExist("reference plane", pl)}`);
        if (!o.path_planes && (o.path_offsets || o.path_host)) p.push(`${at}: path_offsets and path_host go with path_planes`);
        if (!o.profile && !o.profile_family) p.push(`${at}: give profile (points) or profile_family`);
        if (o.profile_family && !families.has(o.profile_family)) p.push(`${at}: ${mayExist("profile family", o.profile_family)}`);
        if (o.subcategory && !subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        solids.add(o.name);
        break;
      case "revolution":
        if (o.end_deg === o.start_deg) p.push(`${at}: start_deg and end_deg are the same`);
        if (o.profile.some((pt) => pt[0] < 0)) p.push(`${at}: a revolution profile can't cross its axis (r must be 0 or more)`);
        if (o.subcategory && !subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        solids.add(o.name);
        break;
      case "blend":
        if (o.end <= o.start) p.push(`${at}: end (${o.end}) must be above start (${o.start})`);
        if (o.subcategory && !subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        solids.add(o.name);
        break;
      case "symbolic_lines": {
        if (!o.points && !o.arc && !o.lines) p.push(`${at}: give points, lines or arc`);
        if (o.arc && o.arc.start_deg === o.arc.end_deg) p.push(`${at}: the arc's start and end angles are the same`);
        if (!subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        const ends = [...(o.lines ?? []).flatMap((l) => [l.from, l.to]), ...(o.arc ? [o.arc.center] : [])];
        const planeNames = ends.flatMap((e) => (Array.isArray(e) ? [] : e.planes));
        for (const e of ends) if (!Array.isArray(e) && e.planes[0] === e.planes[1]) p.push(`${at}: an end names the plane "${e.planes[0]}" twice (it needs two planes that cross)`);
        (o.lines ?? []).forEach((l, k) => {
          if (Array.isArray(l.from) && Array.isArray(l.to) && l.from[0] === l.to[0] && l.from[1] === l.to[1]) p.push(`${at}: line ${k + 1} has no length`);
          if (!Array.isArray(l.from) && !Array.isArray(l.to) && sameSet(l.from.planes, l.to.planes)) p.push(`${at}: line ${k + 1} starts and ends on the same two planes (no length)`);
        });
        const ks = o.repeat ? Array.from({ length: o.repeat.max }, (_, i) => i + 1) : [0];
        if (o.repeat) {
          if (!planeNames.some((n) => n.includes("{k}"))) p.push(`${at}: a repeat needs {k} in a plane name (e.g. "Leaf {k} Left"), or every set is drawn in the same place`);
          integerParam(o.repeat.count_param, `${at}: repeat`);
        } else if (planeNames.some((n) => n.includes("{k}"))) p.push(`${at}: {k} in a plane name needs repeat`);
        const want = new Set(ks.flatMap((k) => planeNames.map((n) => n.split("{k}").join(String(k)))));
        for (const pl of want) if (!planes.has(pl)) p.push(`${at}: ${mayExist("reference plane", pl)}`);
        if (o.arc?.radius_param) lengthParam(o.arc.radius_param, `${at}: radius_param`);
        if (o.show_if !== undefined && !o.show_if.trim()) p.push(`${at}: show_if is empty`);
        lines.add(o.name);
        break;
      }
      case "array": {
        if (o.name === o.solid) p.push(`${at}: the array needs its own name, not the solid's`);
        if (!solids.has(o.solid)) p.push(`${at}: ${mayExist("solid", o.solid)}`);
        integerParam(o.count_param, at);
        const ways = [o.spacing_mm !== undefined, !!o.spacing_param, !!o.between].filter(Boolean).length;
        if (o.spacing_mm === 0) p.push(`${at}: spacing_mm can't be 0`);
        if (o.mode === "copies") {
          if (o.spacing_mm === undefined) p.push(`${at}: copies need spacing_mm`);
          if (o.spacing_param) p.push(`${at}: spacing_param needs mode "linear" (copies sit at spacing_mm; let the count follow the size instead, e.g. a formula rounddown(Height / 100))`);
          if (o.between) p.push(`${at}: between needs mode "linear"`);
        } else {
          if (ways !== 1) p.push(`${at}: linear takes exactly one of spacing_mm, spacing_param or between`);
          if (o.spacing_param) lengthParam(o.spacing_param, at);
          if (o.between) {
            if (o.between[0] === o.between[1]) p.push(`${at}: between needs two different planes`);
            for (const pl of o.between) if (!planes.has(pl)) p.push(`${at}: ${mayExist("reference plane", pl)}`);
          }
        }
        for (let k = 2; k <= (o.mode === "copies" ? o.max : 0); k++) solids.add(`${o.solid} #${k}`);
        break;
      }
      case "delete_template_element":
        if (o.kind === "any" && !o.subcategory && !o.element_name)
          p.push(`${at}: say what goes: a kind, a subcategory or an element_name (a category alone would match everything)`);
        break;
      case "set_default_size":
        if (!Object.keys(o.values).length) p.push(`${at}: values names no parameter`);
        for (const n of Object.keys(o.values)) {
          if (paramTypes.has(n) && paramTypes.get(n) !== "Length") p.push(`${at}: "${n}" is ${paramTypes.get(n)}: set_default_size sets Length parameters`);
          else if (!params.has(n) && !TEMPLATE_SIZE_PARAMS.has(n)) p.push(`${at}: ${mayExist("parameter", n)}`);
        }
        if (o.type) types.add(o.type);
        break;
      case "set_type_image": {
        const file = o.path.replace(/\//g, "\\");
        if (!/\.(png|jpe?g)$/i.test(file)) p.push(`${at}: set_type_image takes a .png or .jpg`);
        if (familiesRoot) {
          const root = familiesRoot.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() + "\\";
          if (!file.toLowerCase().startsWith(root) || file.includes("..")) p.push(`${at}: ${o.path} isn't inside the kit's families folder (${familiesRoot})`);
        }
        if (o.type && !types.has(o.type)) p.push(`${at}: ${mayExist("type", o.type)}`);
        break;
      }
      case "set_subcategory":
        if (!solids.has(o.name) && !lines.has(o.name)) p.push(`${at}: ${mayExist("solid or line set", o.name)}`);
        if (!subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        break;
      case "lock_face":
        if (o.name !== `${o.solid}/${o.plane}`) p.push(`${at}: name must be "${o.solid}/${o.plane}"`);
        if (!solids.has(o.solid)) p.push(`${at}: ${mayExist("solid", o.solid)}`);
        if (!planes.has(o.plane)) p.push(`${at}: ${mayExist("reference plane", o.plane)}`);
        break;
      case "add_eq_dimension":
        if (new Set(o.planes).size !== o.planes.length) p.push(`${at}: a plane is named twice`);
        for (const pl of o.planes) if (!planes.has(pl)) p.push(`${at}: ${mayExist("reference plane", pl)}`);
        break;
      case "load_family": {
        const file = o.path.replace(/\//g, "\\");
        if (!/\.rfa$/i.test(file)) p.push(`${at}: load_family takes an .rfa`);
        if (file.split("\\").includes("..")) p.push(`${at}: ${o.path} climbs out of its folder (..): name it from the kit's families root`);
        else if (isAbsolutePath(file)) {
          const roots = [...(familiesRoot ? [familiesRoot] : []), ...(opts.libraryRoots ?? [])];
          if (roots.length && !roots.some((r) => isInside(file, r)))
            p.push(`${at}: ${o.path} isn't inside the kit's families folder (${roots.join(", ")}). Write it relative to the family ` +
              `staging root, e.g. ${relativeHint(file)}, so it works on any PC`);
        }
        families.add(o.name);
        break;
      }
      case "place_nested":
        if (!families.has(o.family)) p.push(`${at}: ${mayExist("family", o.family)}`);
        for (const hp of Object.values(o.params)) if (!params.has(hp)) p.push(`${at}: ${mayExist("parameter", hp)}`);
        break;
      case "add_dimension":
        for (const pl of o.between) if (!planes.has(pl)) p.push(`${at}: reference plane "${pl}" isn't made earlier in this batch or a template default (it may exist in the file: then it's fine)`);
        if (o.between[0] === o.between[1]) p.push(`${at}: a dimension needs two different planes`);
        break;
    }
  });
  // F-026: planes drawn while the template's default size is current can end on the wrong side once a labelled
  // dimension takes the type's size. A batch that sizes Width or Height sets its default size before any plane.
  const sizes = ops.some((o) => (o.op === "add_dimension" && SIZE_PARAMS.has(o.label ?? "")) || (o.op === "set_type_value" && SIZE_PARAMS.has(o.param))
    || (o.op === "add_family_param" && SIZE_PARAMS.has(o.name)));
  const firstPlane = ops.findIndex((o) => o.op === "add_ref_plane");
  const firstSize = ops.findIndex((o) => o.op === "set_default_size");
  if (sizes && firstPlane >= 0 && firstSize >= 0 && firstPlane < firstSize) {
    const o = ops[firstPlane];
    p.push(`op ${firstPlane + 1} (${o.op} ${o.name}): ${WARNING} (F-026) this plane is drawn before set_default_size (op ${firstSize + 1}), ` +
      "so it is placed at the template's default size and a labelled dimension can pull a plane to the other side. Put set_default_size with the first type's Width and Height first");
  }
  // F-064: geometry Revit refuses mid-build (short dimensions and edges, a locked face just off its plane)
  p.push(...geometryProblems(ops));
  // A plane named only in a warning is fine when the file has it; the hard errors are the ones above other than "may exist".
  return p;
}

/** Hard problems stop the batch; "may exist in the file" notes and warnings are passed on as notes. */
export function splitProblems(problems: string[]): { errors: string[]; notes: string[] } {
  const note = (x: string) => x.includes("may exist in the file") || x.includes(WARNING);
  return { errors: problems.filter((x) => !note(x)), notes: problems.filter(note) };
}
