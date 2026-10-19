/**
 * QS03 (docs/handoff/QS03_DETAIL_GENERATOR.md; owner's yes, 19 Oct): the detail generator. A standard recipe (LOD 200)
 * becomes its `_Detailed` recipe: the box hardware gives way to small component families with true curved shapes,
 * nested on the host's own planes and locked there (so a door still cuts and flexes on every size); everything that
 * opens gets the instance switch `Open`; clearance stays shown. Pure: recipes in, recipes out, no Revit, no AI.
 *
 * Components are drawn about their own origin, and the references they lock by are planes in their recipe:
 *   - the template's Center (Left/Right) and Center (Front/Back) at x = 0 and y = 0,
 *   - "Face" at y = 0 marked Back (the face they are fixed to; the part stands out toward -y),
 *   - "Axis" at z = 0 marked Center (Elevation) or "Base" at z = 0 marked Bottom,
 *   - "Edge" planes marked Left where a part locks by its edge (its offset is in COMPONENTS[...].refs).
 */
import { NOT_BODY } from "./recipes.js";

type Op = Record<string, any>;
type Pt = number[];

export interface RecipeLike { schema?: string; family: string; template: string; about?: string; ops: Op[]; values?: Record<string, any>; checks?: Record<string, any> }

const circle = (r: number, n = 12): Pt[] => Array.from({ length: n }, (_, i) => {
  const a = (2 * Math.PI * i) / n;
  return [Math.round(r * Math.cos(a) * 100) / 100, Math.round(r * Math.sin(a) * 100) / 100];
});

/** A rounded rectangle outline [w × h, corner r] about its centre, 4 points per corner (the twin smooths them). */
export function roundedRect(w: number, h: number, r: number, cx = 0, cy = 0): Pt[] {
  const pts: Pt[] = [];
  const corners: Array<[number, number, number]> = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
  for (const [x, y, a0] of corners)
    for (let k = 0; k <= 3; k++) {
      const a = ((a0 + k * 30) * Math.PI) / 180;
      pts.push([Math.round((cx + x + r * Math.cos(a)) * 100) / 100, Math.round((cy + y + r * Math.sin(a)) * 100) / 100]);
    }
  return pts;
}

/** The ops every component starts with: category, its material parameter and kit material, its subcategory, its reference planes. */
export function componentHead(category: string, subcategory: string, materialParam: string, material: string): Op[] {
  return [
    { op: "set_category", name: category },
    { op: "delete_template_element", name: "Template solids", kind: "solid" },
    { op: "add_subcategory", name: subcategory, line_weight_projection: 1 },
    { op: "add_family_param", name: materialParam, type: "Material", group: "Materials" },
    { op: "add_material", name: material, param: materialParam },
    { op: "add_ref_plane", name: "Face", from: [-500, 0], to: [500, 0], is_reference: "Back" },
  ];
}

/** Each solid on the subcategory, with the material, shown on Medium and Fine (the twin takes Fine later). */
export function finish(solids: string[], subcategory: string, materialParam: string): Op[] {
  return solids.flatMap((s) => [
    { op: "set_subcategory", name: s, subcategory },
    { op: "set_material_param", name: s, param: materialParam },
    { op: "set_visibility", name: s, coarse: false, medium: true, fine: true },
  ]);
}

export const PART_VALUES = { "Typical size": { value: "door hardware, catalogue average", source_status: "assumed", source: "typical hospital door hardware; confirm from the chosen product" } };
export const PART_CHECKS = { keynote_exempt: "nested hardware component: scheduled with its door, not on its own" };

/** The components the generator knows, each a recipe for one small family. */
export const COMPONENTS: Record<string, { family: (role: string) => string; recipe: (role: string) => RecipeLike }> = {
  /** A lever on a round rose; types "52_ArmLeft" and "52_ArmRight" (which way the lever points, seen from the face). */
  lever_rose: {
    family: (role) => `FMC_${role}_Part_LeverRose`,
    recipe: (role) => {
      const sub = "Ironmongery", mat = "Ironmongery Material";
      const lever = (side: -1 | 1): Pt[] => [[0, -50], [side * 6, -56], [side * 15, -59.5], [side * 25, -60], [side * 118, -60], [side * 126, -58]];
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Metal_StainlessSteel_Brushed"),
        { op: "add_ref_plane", name: "Axis", from: [-500, 0], to: [500, 0], view: "Front", is_reference: "CenterElevation" },
        { op: "add_ref_plane", name: "Edge", from: [-26, -500], to: [-26, 500], is_reference: "Left" },
        { op: "add_family_param", name: "Mirror", type: "YesNo", group: "Constraints" },
        { op: "add_family_param", name: "Arm To Left", type: "YesNo", group: "Constraints" },
        // a formula needs a current type, and the Generic Model template starts with none
        { op: "add_type", name: "52_ArmLeft" },
        { op: "set_formula", name: "Arm To Left", formula: "not(Mirror)" },
        // the rose: a disc 52 mm across, 8 mm deep with a rounded edge; the neck; the lever
        { op: "revolution", name: "Rose", axis: "y", axis_at: [0, 0], profile: [[0, 0], [26, 0], [26, 5], [25, 7], [23, 8], [0, 8]] },
        { op: "revolution", name: "Neck", axis: "y", axis_at: [0, 0], profile: [[0, 8], [9, 8], [9, 50], [0, 50]] },
        { op: "sweep", name: "Arm L", path_plane: "plan", at: 0, path: lever(-1), profile: circle(9.5) },
        { op: "sweep", name: "Arm R", path_plane: "plan", at: 0, path: lever(1), profile: circle(9.5) },
        ...finish(["Rose", "Neck", "Arm L", "Arm R"], sub, mat),
        { op: "set_visible_param", name: "Arm L/Visible", solid: "Arm L", param: "Arm To Left" },
        { op: "set_visible_param", name: "Arm R/Visible", solid: "Arm R", param: "Mirror" },
        { op: "set_type_value", name: "52_ArmLeft/Mirror", type: "52_ArmLeft", param: "Mirror", value: false },
        { op: "add_type", name: "52_ArmRight" },
        { op: "set_type_value", name: "52_ArmRight/Mirror", type: "52_ArmRight", param: "Mirror", value: true },
      ];
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_LeverRose`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "Lever on a round rose (QS03 component): fixed true shape, nested on the door's planes. 52_ArmLeft / 52_ArmRight types." };
    },
  },
  /** A butt hinge seen from the swing side: the knuckle with its tips, and the two leaves. Base at z = 0, axis at the origin. */
  butt_hinge: {
    family: (role) => `FMC_${role}_Part_ButtHinge`,
    recipe: (role) => {
      const sub = "Ironmongery", mat = "Ironmongery Material";
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Metal_StainlessSteel_Brushed"),
        { op: "add_ref_plane", name: "Base", from: [-500, 0], to: [500, 0], view: "Front", is_reference: "Bottom" },
        { op: "revolution", name: "Knuckle", axis_at: [0, 0], profile: [[0, 0], [2, 0], [6.5, 3], [7, 6], [7, 94], [6.5, 97], [2, 100], [0, 100]] },
        // both leaves run from the knuckle into the door's thickness (-y), one on the door edge, one on the frame rebate
        { op: "extrusion", name: "Leaf Frame Side", sketch: "plan", start: 2, end: 98, points: [[-3.2, -6], [-0.2, -6], [-0.2, -38], [-3.2, -38]] },
        { op: "extrusion", name: "Leaf Door Side", sketch: "plan", start: 2, end: 98, points: [[0.2, -6], [3.2, -6], [3.2, -38], [0.2, -38]] },
        ...finish(["Knuckle", "Leaf Frame Side", "Leaf Door Side"], sub, mat),
      ];
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_ButtHinge`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "Butt hinge 100 mm with knuckle and tips (QS03 component): its axis locks to the door's hinge edge and swing face." };
    },
  },
  /** An overhead door closer: the rounded body on the leaf face and the arm to the frame head. Body from x = 0 to 260. */
  overhead_closer: {
    family: (role) => `FMC_${role}_Part_OverheadCloser`,
    recipe: (role) => {
      const sub = "Ironmongery", mat = "Ironmongery Material";
      // drawn on the face at y = 0 standing out toward +y (it sits on the push face, the interior), base at z = 0
      const body = roundedRect(48, 58, 10, 24, 29);   // across (y) × up (z), in the right elevation
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Metal_Aluminium_Anodised_Silver"),
        { op: "add_ref_plane", name: "Base", from: [-500, 0], to: [500, 0], view: "Front", is_reference: "Bottom" },
        { op: "extrusion", name: "Body", sketch: "right", start: 0, end: 260, points: body },
        { op: "revolution", name: "Spindle", axis_at: [215, 30], profile: [[0, 58], [9, 58], [9, 70], [0, 70]] },
        { op: "sweep", name: "Arm", path_plane: "plan", at: 70, path: [[215, 30], [150, 70], [60, 85]], profile: [[6, 0], [6, 4], [-6, 4], [-6, 0]] },
        { op: "revolution", name: "Arm Shoe", axis_at: [60, 85], profile: [[0, 70], [10, 70], [10, 82], [0, 82]] },
        ...finish(["Body", "Spindle", "Arm", "Arm Shoe"], sub, mat),
      ];
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_OverheadCloser`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "Overhead closer with arm (QS03 component): body on the push face, arm to the frame head." };
    },
  },
  /** A D-bar pull handle 300 mm between centres, on two standoffs; its middle at z = 0 (locked to the lever height). */
  pull_handle: {
    family: (role) => `FMC_${role}_Part_PullHandle`,
    recipe: (role) => {
      const sub = "Ironmongery", mat = "Ironmongery Material";
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Metal_StainlessSteel_Brushed"),
        { op: "add_ref_plane", name: "Axis", from: [-500, 0], to: [500, 0], view: "Front", is_reference: "CenterElevation" },
        { op: "add_ref_plane", name: "Edge", from: [-26, -500], to: [-26, 500], is_reference: "Left" },
        { op: "revolution", name: "Standoff Top", axis: "y", axis_at: [0, 150], profile: [[0, 0], [11, 0], [11, 3], [9, 5], [9, 55], [0, 55]] },
        { op: "revolution", name: "Standoff Bottom", axis: "y", axis_at: [0, -150], profile: [[0, 0], [11, 0], [11, 3], [9, 5], [9, 55], [0, 55]] },
        // the bar: 25 mm across, from 25 mm past the top standoff to 25 mm past the bottom one, with rounded ends
        { op: "sweep", name: "Bar", path_plane: "right", at: 0, path: [[-67.5, -175], [-67.5, 175]], profile: circle(12.5) },
        { op: "revolution", name: "Bar End Top", axis_at: [0, -67.5], profile: [[0, 175], [12.5, 175], [11, 181], [6, 186], [0, 187.5]] },
        { op: "revolution", name: "Bar End Bottom", axis_at: [0, -67.5], profile: [[0, -187.5], [6, -186], [11, -181], [12.5, -175], [0, -175]] },
        ...finish(["Standoff Top", "Standoff Bottom", "Bar", "Bar End Top", "Bar End Bottom"], sub, mat),
      ];
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_PullHandle`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "D-bar pull handle, 300 mm centres (QS03 component): on the pull face, nested on the door's planes." };
    },
  },
  /** The "X-ray in use" warning light box with the yellow radiation sign beside it, above the door head; base at z = 0. */
  warning_light: {
    family: (role) => `FMC_${role}_Part_RadiationWarningLight`,
    recipe: (role) => {
      const sub = "Signage", mat = "Light Box Material", lens = "Lens Material", sign = "Sign Material";
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Plastic_ABS_White"),
        { op: "add_family_param", name: lens, type: "Material", group: "Materials" },
        { op: "add_material", name: "FMC_Plastic_LED_Red", param: lens },
        { op: "add_family_param", name: sign, type: "Material", group: "Materials" },
        { op: "add_material", name: "FMC_Plastic_ABS_Yellow", param: sign },
        { op: "add_ref_plane", name: "Base", from: [-500, 0], to: [500, 0], view: "Front", is_reference: "Bottom" },
        // the box 300 × 120, 70 deep, 40 mm above the base; its lens across the front; the sign plate to its left
        { op: "extrusion", name: "Light Box", sketch: "front", start: 0, end: 70, points: roundedRect(300, 120, 12, 0, 100) },
        { op: "extrusion", name: "Lens", sketch: "front", start: 70, end: 76, points: roundedRect(270, 90, 8, 0, 100) },
        { op: "extrusion", name: "Sign Plate", sketch: "front", start: 0, end: 3, points: roundedRect(200, 200, 10, -290, 140) },
      ];
      ops.push(...finish(["Light Box"], sub, mat), ...finish(["Lens"], sub, lens), ...finish(["Sign Plate"], sub, sign));
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_RadiationWarningLight`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "Radiation warning light box 'X-ray in use' with the yellow trefoil sign plate (QS03 component): above an X-ray room door." };
    },
  },
};

// ---- the door ----------------------------------------------------------------------------------------------------

/** Box hardware the components replace in the standard door (the planes they used stay: the components lock to them). */
const DOOR_REPLACED = /^(Lever (Rose|Neck|Arm|Return) (Ext|Int)|Hinge [AB] \d|Closer (Body|Arm|Shoe))$/;
/** The parts that move with the leaf: hidden when the door is open (the open leaf takes their place). */
const DOOR_LEAF = /^(Leaf A|Leaf A (Below|Above|Left Of Opening|Right Of Opening)|Vision Glass A|Leaf Lipping A [LR]|Lead Lining A|Kick Plate (Ext|Int)|Push Plate|Lock Forend|Lever Escutcheon (Ext|Int))$/;
const DOOR_LEAF_B = /^(Leaf B)$/;

/** Removes ops about the named solids (their own op, subcategory, material, visibility, locks, switches). */
export function withoutSolids(ops: Op[], drop: (name: string) => boolean): Op[] {
  const dropped = new Set(ops.filter((o) => ["extrusion", "void_extrusion", "sweep", "revolution", "blend"].includes(o.op) && drop(String(o.name))).map((o) => String(o.name)));
  return ops.filter((o) => {
    if (dropped.has(String(o.name))) return false;
    if ((o.op === "lock_face" || o.op === "set_visible_param") && dropped.has(String(o.solid))) return false;
    return true;
  });
}

export interface DetailResult { recipe: RecipeLike; components: string[]; notes: string[] }

// ---- the Coarse envelope (F-071; owner's rule F70, 18 Oct: one family, three levels) ------------------------------

/** The kit's envelope subcategory, as the product recipes (pgen) draw it. */
export const ENVELOPE_SUBCATEGORY = { op: "add_subcategory", name: "Coarse Envelope", color: [120, 130, 140], line_weight_projection: 2 };
const SOLID_OPS = new Set(["extrusion", "revolution", "sweep", "blend"]);

/** Where each of the recipe's own reference planes sits: plan lines with a fixed x or y, elevation lines with a fixed height. */
function planeAt(ops: Op[]): Map<string, { axis: "x" | "y" | "z"; v: number }> {
  const at = new Map<string, { axis: "x" | "y" | "z"; v: number }>();
  for (const o of ops) {
    if (o.op !== "add_ref_plane" || !Array.isArray(o.from) || !Array.isArray(o.to)) continue;
    const [a, b] = [o.from as number[], o.to as number[]];
    if (typeof o.view === "string" && !/plan|level/i.test(o.view)) { if (a[1] === b[1]) at.set(String(o.name), { axis: "z", v: a[1] }); }
    else if (a[0] === b[0]) at.set(String(o.name), { axis: "x", v: a[0] });
    else if (a[1] === b[1]) at.set(String(o.name), { axis: "y", v: a[1] });
  }
  return at;
}

/** A body solid: not a clearance zone, connector pad or light path (recipes.ts NOT_BODY), not the envelope itself. */
const isBody = (name: string) => !NOT_BODY.test(name) && !/envelope/i.test(name);

/**
 * The Coarse level (F-071): a "Coarse Envelope" box around the closed body, between the outermost of the recipe's own
 * planes its body solids are drawn between (so it flexes with Width, Height and the frame depth, as they do), from the
 * lowest bottom to the highest top of the body (on the plane there when the recipe has one), on the Coarse Envelope
 * subcategory, shown only on Coarse. The open positions (solids named "... Open") don't count: the box is the closed
 * element. hideBodyOnCoarse hides the body on Coarse. Null when the recipe has an envelope already or its body isn't
 * drawn between planes on every side.
 */
export function coarseEnvelope(ops: Op[]): Op[] | null {
  if (ops.some((o) => SOLID_OPS.has(o.op) && /envelope/i.test(String(o.name)))) return null;
  const at = planeAt(ops);
  const body = ops.filter((o) => o.op === "extrusion" && Array.isArray(o.rect) && isBody(String(o.name)) && !/ Open$/.test(String(o.name)));
  const outer = (names: string[], axis: "x" | "y", low: boolean) => names.filter((n) => at.get(n)?.axis === axis)
    .sort((a, b) => (low ? at.get(a)!.v - at.get(b)!.v : at.get(b)!.v - at.get(a)!.v))[0];
  const xs = body.flatMap((o) => [o.rect[0], o.rect[1]]), ys = body.flatMap((o) => [o.rect[2], o.rect[3]]);
  const [l, r, e, i] = [outer(xs, "x", true), outer(xs, "x", false), outer(ys, "y", true), outer(ys, "y", false)];
  if (!l || !r || !e || !i) return null;
  const z = (o: Op, end: boolean) => { const p = at.get(String(end ? o.end_plane : o.start_plane)); return p?.axis === "z" ? p.v : Number(end ? o.end ?? 1000 : o.start ?? 0); };
  const z0 = Math.min(...body.map((o) => z(o, false))), z1 = Math.max(...body.map((o) => z(o, true)));
  const zPlane = (v: number) => [...at].find(([, p]) => p.axis === "z" && p.v === v)?.[0];
  const [b, t] = [zPlane(z0), zPlane(z1)];
  return [
    ...(ops.some((o) => o.op === "add_subcategory" && o.name === ENVELOPE_SUBCATEGORY.name) ? [] : [{ ...ENVELOPE_SUBCATEGORY }]),
    { op: "extrusion", name: "Coarse Envelope", rect: [l, r, e, i], start: z0, end: z1, ...(b ? { start_plane: b } : {}), ...(t ? { end_plane: t } : {}) },
    { op: "set_subcategory", name: "Coarse Envelope", subcategory: ENVELOPE_SUBCATEGORY.name },
    { op: "set_visibility", name: "Coarse Envelope", coarse: true, medium: false, fine: false },
  ];
}

/** Every body solid in the ops hidden on Coarse: existing set_visibility ops lose coarse, solids without one get one. */
export function hideBodyOnCoarse(ops: Op[]): Op[] {
  const solids = ops.filter((o) => SOLID_OPS.has(o.op) && isBody(String(o.name))).map((o) => String(o.name));
  const has = new Set(ops.filter((o) => o.op === "set_visibility").map((o) => String(o.name)));
  const out = ops.map((o) => (o.op === "set_visibility" && isBody(String(o.name)) && o.coarse !== false ? { ...o, coarse: false } : o));
  for (const s of solids) if (!has.has(s)) out.push({ op: "set_visibility", name: s, coarse: false, medium: true, fine: true });
  return out;
}

/**
 * A standard door (Metric Door.rft, the dgen2 plane scheme) → its detailed recipe: levers on roses both faces,
 * three hinges (and the pair leaf's when Pair), the overhead closer, nested on the door's planes; the switch Open
 * (instance, default No) that shows the leaf swung 90° to the interior, inside the clearance; clearance kept.
 */
export interface DoorOptions {
  /** A D-bar pull handle on the exterior (pull) face instead of the exterior lever (the X-ray door). */
  pull?: boolean;
  /** The radiation warning light box and sign above the head, centred on the door (the X-ray door). */
  warning_light?: boolean;
}

export function detailDoor(std: RecipeLike, componentPath: (family: string) => string, opts: DoorOptions = {}): DetailResult {
  const role = (/^FMC_([A-Z]{1,2})_/.exec(std.family) ?? [])[1] ?? "A";
  const notes: string[] = [];
  const has = (pl: string) => std.ops.some((o) => o.op === "add_ref_plane" && o.name === pl);
  const need = ["Leaf Left", "Leaf Right", "Leaf Ext", "Leaf Int", "Rose L", "Rose R", "Lever Mid", "Closer L", "Closer Bot", "Hinge 1 Bot", "Hinge 2 Bot", "Hinge 3 Bot", "Leaf Top"];
  const missing = need.filter((p) => !has(p));
  if (missing.length) throw new Error(`${std.family} isn't a dgen2 door: no plane ${missing.join(", ")}`);
  const visParam = new Map(std.ops.filter((o) => o.op === "set_visible_param").map((o) => [String(o.solid), String(o.param)]));
  const types = std.ops.filter((o) => o.op === "add_type").map((o) => String(o.name));

  let ops = withoutSolids(std.ops, (n) => DOOR_REPLACED.test(n));

  // the components, loaded and locked on the planes
  const lever = COMPONENTS.lever_rose.family(role), hinge = COMPONENTS.butt_hinge.family(role), closer = COMPONENTS.overhead_closer.family(role);
  const add: Op[] = [
    { op: "load_family", name: lever, path: componentPath(lever) },
    { op: "load_family", name: hinge, path: componentPath(hinge) },
    { op: "load_family", name: closer, path: componentPath(closer) },
    ...(opts.pull ? [{ op: "load_family", name: COMPONENTS.pull_handle.family(role), path: componentPath(COMPONENTS.pull_handle.family(role)) }] : []),
    ...(opts.warning_light ? [{ op: "load_family", name: COMPONENTS.warning_light.family(role), path: componentPath(COMPONENTS.warning_light.family(role)) },
      // on the wall face above the architrave, centred on the door: it follows Width and Height, and stays when Open
      { op: "place_nested", name: "Warning Light", family: COMPONENTS.warning_light.family(role), type: COMPONENTS.warning_light.family(role),
        lock: { x: { plane: "Center (Left/Right)", ref: "CenterLeftRight" }, y: { plane: "Arch Ext", ref: "Back" }, z: { plane: "Arch Top", ref: "Bottom" } } }] : []),
    // the exterior lever stands out to -y from the exterior face, pointing to the hinge (-x); the interior one is turned
    // round (so it stands out to +y) and mirrored, so it points to the hinge too
    opts.pull
      ? { op: "place_nested", name: "Lever Ext", family: COMPONENTS.pull_handle.family(role), type: COMPONENTS.pull_handle.family(role),
        lock: { x: { plane: "Rose L", ref: "Left", at: -26 }, y: { plane: "Leaf Ext", ref: "Back" }, z: { plane: "Lever Mid", ref: "CenterElevation" } } }
      : { op: "place_nested", name: "Lever Ext", family: lever, type: "52_ArmLeft",
        lock: { x: { plane: "Rose L", ref: "Left", at: -26 }, y: { plane: "Leaf Ext", ref: "Back" }, z: { plane: "Lever Mid", ref: "CenterElevation" } } },
    { op: "place_nested", name: "Lever Int", family: lever, type: "52_ArmRight", rotate_deg: 180,
      lock: { x: { plane: "Rose R", ref: "Left", at: -26 }, y: { plane: "Leaf Int", ref: "Back" }, z: { plane: "Lever Mid", ref: "CenterElevation" } } },
    { op: "place_nested", name: "Closer", family: closer, type: closer,
      lock: { x: { plane: "Closer L", ref: "CenterLeftRight" }, y: { plane: "Leaf Int", ref: "Back" }, z: { plane: "Closer Bot", ref: "Bottom" } } },
  ];
  for (const n of [1, 2, 3]) {
    add.push({ op: "place_nested", name: `Hinge A ${n}`, family: hinge, type: hinge,
      lock: { x: { plane: "Leaf Left", ref: "CenterLeftRight" }, y: { plane: "Leaf Int", ref: "CenterFrontBack" }, z: { plane: `Hinge ${n} Bot`, ref: "Bottom" } } });
    add.push({ op: "place_nested", name: `Hinge B ${n}`, family: hinge, type: hinge,
      lock: { x: { plane: "Leaf Right", ref: "CenterLeftRight" }, y: { plane: "Leaf Int", ref: "CenterFrontBack" }, z: { plane: `Hinge ${n} Bot`, ref: "Bottom" } } });
  }

  // Open: an instance switch, No by default; every leaf part shows when closed (its own switch and not Open)
  add.push({ op: "add_family_param", name: "Open", type: "YesNo", group: "Constraints", instance: true });
  for (const t of types) add.push({ op: "set_type_value", name: `${t}/Open`, type: t, param: "Open", value: false });
  add.push({ op: "add_family_param", name: "Closed", type: "YesNo", group: "Constraints", instance: true });
  add.push({ op: "set_formula", name: "Closed", formula: "not(Open)" });
  const shown = new Map<string, string>();   // a leaf part's switch → its closed-only switch
  const closedSwitch = (base: string | undefined) => {
    if (!base) return "Closed";
    if (!shown.has(base)) {
      const n = `${base} Closed`;
      shown.set(base, n);
      add.push({ op: "add_family_param", name: n, type: "YesNo", group: "Constraints", instance: true });
      add.push({ op: "set_formula", name: n, formula: `and(${base}, not(Open))` });
    }
    return shown.get(base)!;
  };
  const leafParts = ops.filter((o) => ["extrusion", "sweep", "revolution"].includes(o.op) && (DOOR_LEAF.test(String(o.name)) || DOOR_LEAF_B.test(String(o.name)))).map((o) => String(o.name));
  ops = ops.filter((o) => !(o.op === "set_visible_param" && leafParts.includes(String(o.solid))));
  for (const s of leafParts) add.push({ op: "set_visible_param", name: `${s}/Visible`, solid: s, param: closedSwitch(visParam.get(s)) });
  // the leaf-mounted components hide with the leaf; the pair leaf's hinges also need Pair
  add.push({ op: "set_visible_param", name: "Lever Ext/Visible", solid: "Lever Ext", param: "Closed" });
  add.push({ op: "set_visible_param", name: "Lever Int/Visible", solid: "Lever Int", param: "Closed" });
  add.push({ op: "set_visible_param", name: "Closer/Visible", solid: "Closer", param: closedSwitch(visParam.get("Closer Body") ?? "Show Closer") });
  for (const n of [1, 2, 3]) add.push({ op: "set_visible_param", name: `Hinge B ${n}/Visible`, solid: `Hinge B ${n}`, param: "Pair" });

  // the open leaves: turned 90° about the hinge edge on the interior face, on planes the sizes drive
  add.push(
    { op: "add_ref_plane", name: "Open Leaf Face", from: [-400, -1500], to: [-400, 1500], is_reference: "WeakReference" },
    { op: "add_dimension", name: "Open Leaf Thickness", between: ["Leaf Left", "Open Leaf Face"], label: "Leaf Thickness" },
    { op: "add_ref_plane", name: "Open Leaf Tip", from: [-2500, 870], to: [2500, 870], is_reference: "WeakReference" },
    { op: "add_dimension", name: "Open Leaf Width", between: ["Leaf Int", "Open Leaf Tip"], label: "Main Leaf Width" },
    { op: "extrusion", name: "Leaf A Open", rect: ["Leaf Left", "Open Leaf Face", "Leaf Int", "Open Leaf Tip"], start: 8, end: 2057, end_plane: "Leaf Top" },
    { op: "add_ref_plane", name: "Open Leaf B Face", from: [400, -1500], to: [400, 1500], is_reference: "WeakReference" },
    { op: "add_dimension", name: "Open Leaf B Thickness", between: ["Open Leaf B Face", "Leaf Right"], label: "Leaf Thickness" },
    { op: "add_ref_plane", name: "Open Leaf B Tip", from: [-2500, 420], to: [2500, 420], is_reference: "WeakReference" },
    { op: "add_dimension", name: "Open Leaf B Width", between: ["Leaf Int", "Open Leaf B Tip"], label: "Leaf B Width" },
    { op: "extrusion", name: "Leaf B Open", rect: ["Open Leaf B Face", "Leaf Right", "Leaf Int", "Open Leaf B Tip"], start: 8, end: 2057, end_plane: "Leaf Top" },
    { op: "add_family_param", name: "Pair Open", type: "YesNo", group: "Constraints", instance: true },
    { op: "set_formula", name: "Pair Open", formula: "and(Pair, Open)" },
  );
  const leafMat = std.ops.find((o) => o.op === "set_material_param" && o.name === "Leaf A")?.param;
  const leafSub = std.ops.find((o) => o.op === "set_subcategory" && o.name === "Leaf A")?.subcategory;
  for (const [s, sw] of [["Leaf A Open", "Open"], ["Leaf B Open", "Pair Open"]] as const) {
    if (leafSub) add.push({ op: "set_subcategory", name: s, subcategory: leafSub });
    if (leafMat) add.push({ op: "set_material_param", name: s, param: leafMat });
    add.push({ op: "set_visibility", name: s, coarse: false, medium: true, fine: true });
    add.push({ op: "set_visible_param", name: `${s}/Visible`, solid: s, param: sw });
  }
  notes.push("Open shows the leaf (and the pair leaf) swung 90° to the interior; the open leaf is a plain slab in this first version (no vision panel or hardware on it)");
  if (!std.ops.some((o) => o.op === "set_visible_param" && o.param === "Show Clearance")) notes.push("No Show Clearance switch in the standard door: add the clearance zones");

  // Coarse (F-071): the LOD 100 box over frame and architraves; the body (and the open leaf) shows on Medium and Fine
  const env = coarseEnvelope([...ops, ...add]);
  if (env) add.push(...env);
  else if (!ops.some((o) => /envelope/i.test(String(o.name)))) notes.push("No Coarse envelope: the door's body isn't drawn between planes on every side");

  // the generator's own ops go before the types are finished (after the last set_formula of the standard recipe)
  const at = ops.map((o) => o.op).lastIndexOf("set_type_value") + 1;
  const out = hideBodyOnCoarse([...ops.slice(0, at), ...add, ...ops.slice(at)]);
  return {
    recipe: { ...std, family: `${std.family}_Detailed`, ops: out,
      about: `Detailed door (QS03 generator, ${new Date().toISOString().slice(0, 10)}): ${std.family} with lever on rose both faces, 3 hinges (pair: 6), overhead closer as nested components locked to its planes; instance switch Open; clearance kept. Coarse LOD 100 envelope; Medium LOD 300; Fine LOD 400 after fmc_rhino twins of the components.` },
    components: [lever, hinge, closer, ...(opts.pull ? [COMPONENTS.pull_handle.family(role)] : []), ...(opts.warning_light ? [COMPONENTS.warning_light.family(role)] : [])],
    notes,
  };
}
