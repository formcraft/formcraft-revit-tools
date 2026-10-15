/**
 * fmc_doc ops (docs/PLAN_B1_ENGINE.md, B1b): the fixed vocabulary a builder sends, validated before Revit sees it.
 * Every op names what it makes, so a batch is idempotent: Revit answers create, update or skip per op. Sizes are mm.
 * Shared parameters come only from the kit's dictionary, by GUID (rule 7). Deleting is never an op.
 */
import { z } from "zod";
import { SpParam } from "./specs.js";

const mm = z.number().finite();
// Fixed-length arrays, not z.tuple: a tuple becomes JSON Schema "items": [a, b], which the Claude API rejects
// ("items must be object,boolean"), and the whole tool drops out of the client. schemas.test.ts checks every tool.
const point = z.array(mm).length(2).describe("[x, y] in mm");
const point3 = z.array(mm).length(3).describe("[x, y, z] in mm");
const VIEWS = ["plan", "front", "right"] as const;
const visibility = {
  coarse: z.boolean().optional(), medium: z.boolean().optional(), fine: z.boolean().optional(),
};
const sweepShape = {
  name: z.string().min(1),
  path: z.array(point).min(2).describe("the path, a polyline in mm in the path plane"),
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
    start: mm.default(0), end: mm.default(1000), end_plane: z.string().optional().describe("a level reference plane to lock the top to"),
    view: z.string().optional() }),
  z.object({ op: z.literal("void_extrusion"), name: z.string().min(1),
    rect: z.array(z.string().min(1)).length(4).optional().describe("left, right, front, back reference planes; each side is locked to its plane"),
    points: z.array(point).min(3).optional().describe("or a closed outline in mm (not locked)"),
    start: mm.default(0), end: mm.default(1000), end_plane: z.string().optional().describe("a level reference plane to lock the top to"),
    view: z.string().optional() }),
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
    axis_at: point.default([0, 0]).describe("the vertical axis in plan, mm"),
    start_deg: z.number().default(0), end_deg: z.number().default(360), subcategory: z.string().optional() }),
  z.object({ op: z.literal("blend"), name: z.string().min(1),
    base: z.array(point).min(3).describe("closed base outline in plan, mm"), top: z.array(point).min(3).describe("closed top outline in plan, mm"),
    start: mm.default(0), end: mm.default(1000), subcategory: z.string().optional() }),
  z.object({ op: z.literal("symbolic_lines"), name: z.string().min(1).describe("one name for the set, e.g. Swing plan"),
    view: z.enum(VIEWS).default("plan").describe("plan lines show in plan views; front in front/back elevations; right in side elevations"),
    at: mm.default(0),
    points: z.array(point).min(2).optional().describe("a polyline in the view's plane, mm"),
    arc: z.object({ center: point, radius: mm.positive(), start_deg: z.number(), end_deg: z.number() }).optional()
      .describe("or an arc, e.g. a door swing"),
    subcategory: z.string().min(1).describe("Plan Swing, Elevation Swing, Hidden Lines…"), ...visibility }),
  z.object({ op: z.literal("lock_face"), name: z.string().min(1).describe("<solid>/<plane>"), solid: z.string().min(1), plane: z.string().min(1),
    view: z.enum(VIEWS).default("plan").describe("plan for vertical planes, front for level planes") }),
  z.object({ op: z.literal("add_eq_dimension"), name: z.string().min(1), planes: z.array(z.string().min(1)).min(3)
    .describe("three or more reference planes in order, e.g. Left, Center (Left/Right), Right"),
    view: z.string().optional(), offset: mm.default(600) }),
  z.object({ op: z.literal("load_family"), name: z.string().min(1).describe("the family name once loaded"),
    path: z.string().min(1).describe("an .rfa in the kit's 04_Families (profiles, detail kit, nested parts)") }),
  z.object({ op: z.literal("place_nested"), name: z.string().min(1), family: z.string().min(1), type: z.string().min(1),
    at: point3.default([0, 0, 0]), rotate_deg: z.number().default(0),
    params: z.record(z.string()).default({}).describe("nested instance parameter → this family's parameter (associated)") }),
]);
export type Op = z.infer<typeof OP>;
export const OPS = z.array(OP).min(1).max(500);

/** Checks the batch as a whole: unique names per op kind, shared parameters from the dictionary, references made earlier. */
export function opsProblems(ops: Op[], dictionary: Map<string, SpParam> | null, familiesRoot?: string): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  const solids = new Set<string>(), connectors = new Set<string>(), subcats = new Set<string>(), lines = new Set<string>(), families = new Set<string>();
  const mayExist = (what: string, n: string) => `reference to ${what} "${n}" that isn't made earlier in this batch (it may exist in the file: then it's fine)`;
  const params = new Set<string>(), types = new Set<string>(), planes = new Set<string>(["Center (Left/Right)", "Center (Front/Back)", "Ref. Level"]);
  ops.forEach((o, i) => {
    const at = `op ${i + 1} (${o.op} ${o.name})`;
    const key = `${o.op}|${o.name.toLowerCase()}`;
    if (seen.has(key)) p.push(`${at}: the same ${o.op} name twice in one batch`);
    seen.add(key);
    switch (o.op) {
      case "add_shared_param": {
        if (!dictionary) { p.push(`${at}: the kit's shared parameter file isn't readable`); break; }
        const d = [...dictionary.values()].find((x) => x.guid.toLowerCase() === o.guid.toLowerCase());
        if (!d) p.push(`${at}: GUID ${o.guid} isn't in FMC_SharedParameters.txt (shared parameters come only from the dictionary)`);
        else if (d.name !== o.name) p.push(`${at}: the dictionary names ${o.guid} "${d.name}", not "${o.name}"`);
        params.add(o.name);
        break;
      }
      case "add_family_param":
        if (dictionary && [...dictionary.values()].some((x) => x.name === o.name))
          p.push(`${at}: "${o.name}" is a kit shared parameter: add it with add_shared_param and its GUID`);
        params.add(o.name);
        break;
      case "add_type": types.add(o.name); break;
      case "extrusion":
      case "void_extrusion":
        if (!o.rect && !o.points) p.push(`${at}: give rect (four reference planes) or points`);
        if (o.end <= o.start) p.push(`${at}: end (${o.end}) must be above start (${o.start})`);
        for (const pl of [...(o.rect ?? []), ...(o.end_plane ? [o.end_plane] : [])])
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
      case "set_type_value":
        if (o.name !== `${o.type}/${o.param}`) p.push(`${at}: name must be "${o.type}/${o.param}"`);
        break;
      case "add_subcategory": subcats.add(o.name); break;
      case "sweep":
      case "void_sweep":
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
      case "symbolic_lines":
        if (!o.points && !o.arc) p.push(`${at}: give points or arc`);
        if (o.arc && o.arc.start_deg === o.arc.end_deg) p.push(`${at}: the arc's start and end angles are the same`);
        if (!subcats.has(o.subcategory)) p.push(`${at}: ${mayExist("subcategory", o.subcategory)}`);
        lines.add(o.name);
        break;
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
        if (familiesRoot) {
          const root = familiesRoot.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() + "\\";
          if (!file.toLowerCase().startsWith(root) || file.includes("..")) p.push(`${at}: ${o.path} isn't inside the kit's families folder (${familiesRoot})`);
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
  // A plane named only in a warning is fine when the file has it; the hard errors are the ones above other than "may exist".
  return p;
}

/** Hard problems stop the batch; "may exist in the file" notes are passed on as warnings. */
export function splitProblems(problems: string[]): { errors: string[]; notes: string[] } {
  return { errors: problems.filter((x) => !x.includes("may exist in the file")), notes: problems.filter((x) => x.includes("may exist in the file")) };
}
