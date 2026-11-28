/**
 * B15 fmc_doc ops for fmc_fam_dim, fmc_fam_visibility, fmc_fam_material and fmc_fam_category (Family coverage review
 * 2026-11-28, section 5 item 4: "add fmc_doc ops instead of new tools"; proposal page 11ee5a5f), in the op layout agreed
 * with Family Editor Bot: dim_*, vis_*, material_*, category_* (its param_*, type_*, plane_* ops are not here). The
 * add-in side is commandset/Services/Fmc/FmcDocFamB15.cs. Op names live only in B15 below (FmcDocFamB15.Op on the C#
 * side), so a rename is one line in each. Kept in its own file so ops.ts only spreads B15_OPS into OP and calls
 * b15Problems once; this file imports nothing from ops.ts (ops.ts imports it, and OP is built at load).
 *
 * Every op keeps fmc_doc's `name` (its identity: a batch is idempotent by name). What an op acts on is element_ids
 * (element ids in the family document) when given, else targets (op names), else its own name.
 */
import { z } from "zod";

/** The B15 op names, in one place (C# twin: FmcDocFamB15.Op). */
export const B15 = {
  DIM_ADD_ANGULAR: "dim_add_angular",
  DIM_ADD_RADIAL: "dim_add_radial",
  DIM_UNLOCK: "dim_unlock",
  VIS_SET: "vis_set",
  VIS_MATRIX: "vis_matrix",
  MATERIAL_SET: "material_set",
  MATERIAL_PAINT: "material_paint",
  MATERIAL_PURGE: "material_purge",
  CATEGORY_SET: "category_set",
  CATEGORY_FLAGS: "category_flags",
  SUBCATEGORY_RENAME: "category_sub_rename",
  SUBCATEGORY_DELETE: "category_sub_delete",
} as const;

const mm = z.number().finite();
// two names as an array with .length(2), never z.tuple (see ops.ts: the Claude API rejects tuple "items")
const twoPlanes = z.array(z.string().min(1)).length(2);
const view = z.string().min(1).optional().describe("plan, front, right or a view's name (default the Ref. Level plan)");
const flag = z.boolean().optional();
const targets = {
  element_ids: z.array(z.number().int().positive()).min(1).optional().describe("element ids in this family document (fmc_doc report)"),
  targets: z.array(z.string().min(1)).min(1).optional().describe("elements by op name (default: the op's own name)"),
};

export const FACES = ["top", "bottom", "left", "right", "front", "back"] as const;
export const DETAIL_LEVELS = ["coarse", "medium", "fine"] as const;
export const VIS_VIEWS = ["plan_rcp", "front_back", "left_right"] as const;

export const B15_OPS = [
  // ---- fmc_fam_dim
  z.object({ op: z.literal(B15.DIM_ADD_ANGULAR), name: z.string().min(1).describe("identity, e.g. Opening angle"),
    refs: twoPlanes.describe("[plane, plane]: two reference planes that cross in the view"),
    label: z.string().min(1).optional().describe("an Angle parameter to label it with"), view,
    radius: mm.positive().optional().describe("mm, the dimension arc's radius (default 300)"),
    side_a: z.number().int().optional().describe("1 (default) or -1: which way along the first plane the arc starts"),
    side_b: z.number().int().optional().describe("1 (default) or -1: which way along the second plane the arc ends") }),
  z.object({ op: z.literal(B15.DIM_ADD_RADIAL), name: z.string().min(1).describe("identity, e.g. Bowl radius"),
    ref: z.string().min(1).describe("a named solid (its circular edge) or line set (its arc), by op name"),
    diameter: z.boolean().optional().describe("a diameter dimension instead of a radius"),
    label: z.string().min(1).optional().describe("a Length parameter to label it with"), view,
    arc_index: z.number().int().min(0).optional().describe("which arc of the ref (default 0, the first)"),
    leader: mm.positive().optional().describe("mm the text sits outside the arc (default 200)") }),
  z.object({ op: z.literal(B15.DIM_UNLOCK), name: z.string().min(1).describe("identity, e.g. Unlock Width"),
    id: z.number().int().positive().optional().describe("the dimension's element id"),
    refs: twoPlanes.optional().describe("or the dimension's two planes"),
    label: z.string().min(1).optional().describe("or every dimension labelled with this parameter") }),
  // ---- fmc_fam_visibility
  z.object({ op: z.literal(B15.VIS_SET), name: z.string().min(1).describe("identity; also the target (a solid, line set or model text by op name) without element_ids or targets"),
    ...targets,
    detail_levels: z.array(z.enum(DETAIL_LEVELS)).min(1).optional().describe("the levels it shows in; the others go off"),
    views: z.array(z.enum(VIS_VIEWS)).optional().describe("the views it shows in (model elements); the others go off"),
    only_when_cut: flag.describe("shown only when cut (model elements)"),
    param: z.string().min(1).optional().describe("a Yes/No family parameter its Visible follows") }),
  z.object({ op: z.literal(B15.VIS_MATRIX), name: z.string().min(1).describe("identity, e.g. Visibility check") }),
  // ---- fmc_fam_material
  z.object({ op: z.literal(B15.MATERIAL_SET), name: z.string().min(1).describe("identity; also the target solid without element_ids, targets or param"),
    ...targets,
    param: z.string().min(1).optional().describe("or a Material family parameter: set to the material in every type"),
    material: z.string().min(1).describe("a material in the family (add_material brings an FMC_ one in from the kit)"),
    detach: z.boolean().optional().describe("a solid's Material follows a parameter: detach it and set it directly") }),
  z.object({ op: z.literal(B15.MATERIAL_PAINT), name: z.string().min(1).describe("<solid>/<face>"), solid: z.string().min(1),
    face: z.enum(FACES).describe("the largest flat face pointing that way"), material: z.string().min(1) }),
  z.object({ op: z.literal(B15.MATERIAL_PURGE), name: z.string().min(1).describe("identity, e.g. Unused materials"),
    delete: z.boolean().default(false).describe("false (default) lists the unused materials only"),
    keep: z.array(z.string().min(1)).optional().describe("materials never purged") }),
  // ---- fmc_fam_category
  z.object({ op: z.literal(B15.CATEGORY_SET), name: z.string().min(1).describe("identity, e.g. Category"),
    category: z.string().min(1).optional().describe("the family category: a Revit category name or OST_ name"),
    subcategory: z.string().min(1).optional().describe("made if new; with element_ids or targets, those move onto it"),
    ...targets }),
  z.object({ op: z.literal(B15.CATEGORY_FLAGS), name: z.literal("family"),
    cut_with_voids: flag.describe("Cut with Voids When Loaded"), can_host_rebar: flag,
    ifc_export_as: z.string().optional().describe("Export to IFC As, e.g. IfcFurniture"),
    ifc_predefined_type: z.string().optional().describe("IFC Predefined Type, e.g. CHAIR") }),
  z.object({ op: z.literal(B15.SUBCATEGORY_RENAME), name: z.string().min(1).describe("the subcategory now"), to: z.string().min(1) }),
  z.object({ op: z.literal(B15.SUBCATEGORY_DELETE), name: z.string().min(1),
    reassign_to: z.string().min(1).optional().describe("move its solids and lines here first; without it, one in use is refused") }),
] as const;

export const B15_OP_NAMES: readonly string[] = Object.values(B15);

/** What opsProblems knows about the batch once it has read every op. */
export interface B15Context {
  planes: Set<string>; params: Set<string>; paramTypes: Map<string, string>;
  solids: Set<string>; lines: Set<string>; subcats: Set<string>; materials: Set<string>;
}

type AnyOp = { op: string; name: string; [k: string]: any };
/** Part Types that make a board (ops.ts PANEL_PART_TYPES; repeated here, ops.ts imports this file). */
const PANEL_PART_TYPES = ["Panelboard", "Switchboard", "Other Panel"];
const MAY = "may exist in the file: then it's fine";
const mayExist = (what: string, n: string) => `reference to ${what} "${n}" that isn't made earlier in this batch (it ${MAY})`;

/** Checks of the B15 ops (the rest of the batch is checked by opsProblems). Same wording rules: "may exist" is a note. */
export function b15Problems(ops: AnyOp[], ctx: B15Context): string[] {
  const p: string[] = [];
  const typed = (n: string | undefined, want: string, at: string) => {
    if (!n) return;
    if (!ctx.params.has(n)) p.push(`${at}: ${mayExist("parameter", n)}`);
    else if (ctx.paramTypes.has(n) && ctx.paramTypes.get(n) !== want) p.push(`${at}: "${n}" is ${ctx.paramTypes.get(n)}, not ${want}`);
  };
  /** element_ids are taken as they are; op-name targets (or the name itself) should be solids or line sets */
  const named = (o: AnyOp, at: string, what: "solid" | "solid or line set") => {
    if (o.element_ids) { if (o.targets) p.push(`${at}: give element_ids or targets, not both`); return; }
    for (const n of (o.targets ?? [o.name]) as string[]) {
      const ok = what === "solid" ? ctx.solids.has(n) : ctx.solids.has(n) || ctx.lines.has(n);
      if (!ok) p.push(`${at}: ${mayExist(what, n)}`);
    }
  };
  // the panel Part Type rule (ops.ts, set_family_params) for a category set by category_set
  let category: string | null = null;
  ops.forEach((o, i) => {
    if (o.op === B15.CATEGORY_SET && o.category) category = o.category;
    if (o.op === "set_family_params" && o.part_type && PANEL_PART_TYPES.includes(o.part_type) && category !== null
      && !ops.slice(0, i).some((x) => x.op === "set_category") && !/^(electrical equipment|OST_ElectricalEquipment)$/i.test(category.trim()))
      p.push(`op ${i + 1} (${o.op} ${o.name}): Part Type ${o.part_type} is for Electrical Equipment, and this batch sets the category to ${category}`);
  });
  ops.forEach((o, i) => {
    if (!B15_OP_NAMES.includes(o.op)) return;
    const at = `op ${i + 1} (${o.op} ${o.name})`;
    switch (o.op) {
      case B15.DIM_ADD_ANGULAR:
        if (o.refs[0] === o.refs[1]) p.push(`${at}: an angle needs two different planes`);
        for (const pl of o.refs) if (!ctx.planes.has(pl)) p.push(`${at}: ${mayExist("reference plane", pl)}`);
        for (const k of ["side_a", "side_b"]) if (o[k] !== undefined && o[k] !== 1 && o[k] !== -1) p.push(`${at}: ${k} is 1 or -1`);
        typed(o.label, "Angle", at);
        break;
      case B15.DIM_ADD_RADIAL:
        if (!ctx.solids.has(o.ref) && !ctx.lines.has(o.ref)) p.push(`${at}: ${mayExist("solid or line set", o.ref)}`);
        typed(o.label, "Length", at);
        break;
      case B15.DIM_UNLOCK: {
        const given = [o.id, o.refs, o.label].filter((x) => x !== undefined).length;
        if (given !== 1) p.push(`${at}: give one of id, refs [plane, plane] or label`);
        if (o.refs) {
          if (o.refs[0] === o.refs[1]) p.push(`${at}: a dimension needs two different planes`);
          for (const pl of o.refs) if (!ctx.planes.has(pl)) p.push(`${at}: ${mayExist("reference plane", pl)}`);
        }
        break;
      }
      case B15.VIS_SET:
        if (o.detail_levels === undefined && o.views === undefined && o.only_when_cut === undefined && o.param === undefined)
          p.push(`${at}: set at least one of detail_levels, views, only_when_cut, param`);
        if (o.detail_levels && new Set(o.detail_levels).size !== o.detail_levels.length) p.push(`${at}: a detail level is named twice`);
        if (o.views && new Set(o.views).size !== o.views.length) p.push(`${at}: a view is named twice`);
        if (o.param) typed(o.param, "YesNo", at);
        named(o, at, "solid or line set");
        break;
      case B15.MATERIAL_SET:
        if (o.param) {
          if (o.element_ids || o.targets) p.push(`${at}: give param or element_ids/targets, not both`);
          typed(o.param, "Material", at);
        } else named(o, at, "solid");
        if (!ctx.materials.has(o.material)) p.push(`${at}: ${mayExist("material", o.material)}`);
        break;
      case B15.MATERIAL_PAINT:
        if (o.name !== `${o.solid}/${o.face}`) p.push(`${at}: name must be "${o.solid}/${o.face}"`);
        if (!ctx.solids.has(o.solid)) p.push(`${at}: ${mayExist("solid", o.solid)}`);
        if (!ctx.materials.has(o.material)) p.push(`${at}: ${mayExist("material", o.material)}`);
        break;
      case B15.CATEGORY_SET:
        if (!o.category && !o.subcategory) p.push(`${at}: give category, subcategory or both`);
        if ((o.element_ids || o.targets) && !o.subcategory) p.push(`${at}: element_ids/targets move elements onto a subcategory: give subcategory`);
        if (o.element_ids && o.targets) p.push(`${at}: give element_ids or targets, not both`);
        if (o.targets) for (const n of o.targets as string[]) if (!ctx.solids.has(n) && !ctx.lines.has(n)) p.push(`${at}: ${mayExist("solid or line set", n)}`);
        break;
      case B15.CATEGORY_FLAGS:
        if (["cut_with_voids", "can_host_rebar", "ifc_export_as", "ifc_predefined_type"].every((k) => o[k] === undefined))
          p.push(`${at}: set at least one of cut_with_voids, can_host_rebar, ifc_export_as, ifc_predefined_type`);
        if (o.ifc_export_as !== undefined && o.ifc_export_as !== "" && !/^Ifc[A-Za-z]+(Type)?$/.test(o.ifc_export_as))
          p.push(`${at}: Export to IFC As is an IFC class name such as IfcFurniture, not "${o.ifc_export_as}"`);
        break;
      case B15.SUBCATEGORY_RENAME:
        if (o.name.toLowerCase() === o.to.toLowerCase()) p.push(`${at}: the new name is the old one`);
        if (!ctx.subcats.has(o.name)) p.push(`${at}: ${mayExist("subcategory", o.name)}`);
        break;
      case B15.SUBCATEGORY_DELETE:
        if (o.reassign_to && o.reassign_to.toLowerCase() === o.name.toLowerCase()) p.push(`${at}: reassign_to is the subcategory being deleted`);
        if (o.reassign_to && !ctx.subcats.has(o.reassign_to)) p.push(`${at}: ${mayExist("subcategory", o.reassign_to)}`);
        break;
    }
  });
  return p;
}
