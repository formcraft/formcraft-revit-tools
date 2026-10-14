/**
 * fmc_doc ops (docs/PLAN_B1_ENGINE.md, B1b): the fixed vocabulary a builder sends, validated before Revit sees it.
 * Every op names what it makes, so a batch is idempotent: Revit answers create, update or skip per op. Sizes are mm.
 * Shared parameters come only from the kit's dictionary, by GUID (rule 7). Deleting is never an op.
 */
import { z } from "zod";
import { SpParam } from "./specs.js";

const mm = z.number().finite();
const point = z.tuple([mm, mm]);

export const DATA_TYPES = ["Length", "Number", "Integer", "YesNo", "Text", "Material", "Area", "Volume", "Angle"] as const;
export const GROUPS = ["Dimensions", "Constraints", "Data", "Text", "Materials", "IdentityData", "Graphics", "Electrical", "ElectricalLoads",
  "Mechanical", "Plumbing", "General"] as const;
export const REFERENCES = ["NotAReference", "WeakReference", "StrongReference", "Left", "CenterLeftRight", "Right", "Front", "CenterFrontBack",
  "Back", "Bottom", "CenterElevation", "Top"] as const;

export const OP = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_category"), name: z.string().min(1).describe("Revit category name, e.g. Generic Models, or OST_ name") }),
  z.object({ op: z.literal("set_family_params"), name: z.literal("family"), work_plane_based: z.boolean().optional(),
    always_vertical: z.boolean().optional(), shared: z.boolean().optional(), room_calculation_point: z.boolean().optional() }),
  z.object({ op: z.literal("add_ref_plane"), name: z.string().min(1), from: point, to: point,
    view: z.string().optional().describe("the plan or elevation view to draw in (default: Ref. Level)"),
    is_reference: z.enum(REFERENCES).optional() }),
  z.object({ op: z.literal("add_family_param"), name: z.string().min(1), type: z.enum(DATA_TYPES), instance: z.boolean().default(false),
    group: z.enum(GROUPS).default("Dimensions") }),
  z.object({ op: z.literal("add_shared_param"), name: z.string().min(1), guid: z.string().min(1), instance: z.boolean().default(false),
    group: z.enum(GROUPS).default("Data") }),
  z.object({ op: z.literal("set_formula"), name: z.string().min(1).describe("the parameter"), formula: z.string() }),
  z.object({ op: z.literal("add_type"), name: z.string().min(1) }),
  z.object({ op: z.literal("set_type_value"), name: z.string().min(1).describe("<type>/<parameter>"), type: z.string().min(1),
    param: z.string().min(1), value: z.union([z.number(), z.string(), z.boolean()]).describe("Length in mm, Angle in degrees") }),
  z.object({ op: z.literal("add_dimension"), name: z.string().min(1).describe("identity: usually the label, e.g. Width"),
    between: z.tuple([z.string().min(1), z.string().min(1)]).describe("two reference planes by name"),
    view: z.string().optional(), label: z.string().optional().describe("a family parameter that drives the dimension"),
    offset: mm.default(300).describe("where the dimension line sits, mm from the first plane") }),
  z.object({ op: z.literal("extrusion"), name: z.string().min(1),
    rect: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional().describe("left, right, front, back reference planes; each side is locked to its plane"),
    points: z.array(point).min(3).optional().describe("or a closed outline in mm (not locked)"),
    start: mm.default(0), end: mm.default(1000), end_plane: z.string().optional().describe("a level reference plane to lock the top to"),
    view: z.string().optional() }),
  z.object({ op: z.literal("void_extrusion"), name: z.string().min(1),
    rect: z.tuple([z.string(), z.string(), z.string(), z.string()]).optional().describe("left, right, front, back reference planes; each side is locked to its plane"),
    points: z.array(point).min(3).optional().describe("or a closed outline in mm (not locked)"),
    start: mm.default(0), end: mm.default(1000), end_plane: z.string().optional().describe("a level reference plane to lock the top to"),
    view: z.string().optional() }),
  z.object({ op: z.literal("set_material_param"), name: z.string().min(1).describe("the solid"), param: z.string().min(1) }),
  z.object({ op: z.literal("set_visibility"), name: z.string().min(1).describe("the solid"), coarse: z.boolean().optional(), medium: z.boolean().optional(),
    fine: z.boolean().optional(), plan_rcp: z.boolean().optional(), front_back: z.boolean().optional(), left_right: z.boolean().optional() }),
]);
export type Op = z.infer<typeof OP>;
export const OPS = z.array(OP).min(1).max(500);

/** Checks the batch as a whole: unique names per op kind, shared parameters from the dictionary, references made earlier. */
export function opsProblems(ops: Op[], dictionary: Map<string, SpParam> | null): string[] {
  const p: string[] = [];
  const seen = new Set<string>();
  const solids = new Set<string>();
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
