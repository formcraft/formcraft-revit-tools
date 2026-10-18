/**
 * QS03 for windows and the shared clearance zone (docs/handoff/QS03_DETAIL_GENERATOR.md). A standard window (Metric
 * Window.rft, the wgen plane scheme) becomes its `_Detailed` recipe: what opens gets the instance switch `Open`, the small
 * parts become components on its planes, and it gets the working-zone clearance. Pure: recipes in, recipes out.
 */
import { COMPONENTS, DetailResult, RecipeLike, componentHead, finish, PART_CHECKS, PART_VALUES, withoutSolids } from "./detailgen.js";

type Op = Record<string, any>;
type Pt = number[];

/**
 * The owner's rule (19 Oct): every family shows its clearance. A zone in front of a face plane, `depth` mm deep (a type
 * parameter, its value marked assumed until confirmed), across `from`..`to`, 10 mm thick at the floor, on the Clearance
 * Approach subcategory, Coarse and Medium, with the instance switch Show Clearance (default Yes). Nothing is added when
 * the family has a Show Clearance switch already.
 */
export function clearanceOps(std: RecipeLike, z: { face: string; side: 1 | -1; from: string; to: string; depth: number; param: string; why: string }): { ops: Op[]; value: Record<string, any> } {
  if (std.ops.some((o) => o.op === "add_family_param" && o.name === "Show Clearance")) return { ops: [], value: {} };
  const types = std.ops.filter((o) => o.op === "add_type").map((o) => String(o.name));
  const plane = `Clear ${z.side > 0 ? "Int" : "Ext"}`;
  const faceY = Number(std.ops.find((o) => o.op === "add_ref_plane" && o.name === z.face)?.from?.[1] ?? 0);
  const y = faceY + z.side * z.depth;
  const ops: Op[] = [
    { op: "add_family_param", name: z.param, type: "Length", group: "Dimensions" },
    { op: "add_family_param", name: "Show Clearance", type: "YesNo", group: "Constraints", instance: true },
    { op: "add_ref_plane", name: plane, from: [-2500, y], to: [2500, y], is_reference: "WeakReference" },
    { op: "add_dimension", name: `${z.param} ${plane}`, between: z.side > 0 ? [z.face, plane] : [plane, z.face], label: z.param },
    { op: "add_subcategory", name: "Clearance Approach", line_weight_projection: 1 },
    { op: "extrusion", name: "Clearance Zone", rect: z.side > 0 ? [z.from, z.to, z.face, plane] : [z.from, z.to, plane, z.face], start: 0, end: 10 },
    { op: "set_subcategory", name: "Clearance Zone", subcategory: "Clearance Approach" },
    { op: "set_visibility", name: "Clearance Zone", coarse: true, medium: true, fine: false },
    { op: "set_visible_param", name: "Clearance Zone/Visible", solid: "Clearance Zone", param: "Show Clearance" },
    ...types.flatMap((t) => [
      { op: "set_type_value", name: `${t}/${z.param}`, type: t, param: z.param, value: z.depth },
      { op: "set_type_value", name: `${t}/Show Clearance`, type: t, param: "Show Clearance", value: true },
    ]),
  ];
  return { ops, value: { [z.param]: { value: z.depth, source_status: "assumed", source: z.why } } };
}

Object.assign(COMPONENTS, {
  /** The integral blind's control knob, 30 mm across, standing out from the face; its centre at the origin. */
  blind_knob: {
    family: (role: string) => `FMC_${role}_Part_BlindKnob`,
    recipe: (role: string): RecipeLike => {
      const sub = "Blind", mat = "Knob Material";
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Plastic_ABS_White"),
        { op: "add_ref_plane", name: "Base", from: [-500, -15], to: [500, -15], view: "Front", is_reference: "Bottom" },
        { op: "add_ref_plane", name: "Edge", from: [-15, -500], to: [-15, 500], is_reference: "Left" },
        { op: "revolution", name: "Knob", axis: "y", axis_at: [0, 0], profile: [[0, 0], [11, 0], [15, 4], [15, 16], [13, 20], [0, 20]] },
        { op: "revolution", name: "Knob Grip", axis: "y", axis_at: [0, 0], profile: [[0, 20], [5, 20], [5, 26], [0, 26]] },
        ...finish(["Knob", "Knob Grip"], sub, mat),
      ];
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_BlindKnob`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "Integral blind control knob (QS03 component): on the window's interior face, nested on its planes." };
    },
  },
  /** A round speech grille 140 mm across with concentric grooves; its centre at the origin. */
  speech_grille: {
    family: (role: string) => `FMC_${role}_Part_SpeechGrille`,
    recipe: (role: string): RecipeLike => {
      const sub = "Ironmongery", mat = "Grille Material";
      const groove: Pt[] = [[0, 0]];
      for (let r = 10; r <= 60; r += 10) groove.push([r - 4, 0], [r - 4, 1.5], [r, 1.5], [r, 0]);
      groove.push([70, 0], [70, 5], [66, 7], [0, 7]);
      const ops: Op[] = [
        ...componentHead("OST_GenericModel", sub, mat, "FMC_Metal_StainlessSteel_Brushed"),
        { op: "add_ref_plane", name: "Axis", from: [-500, 0], to: [500, 0], view: "Front", is_reference: "CenterElevation" },
        { op: "revolution", name: "Grille", axis: "y", axis_at: [0, 0], profile: groove },
        ...finish(["Grille"], sub, mat),
      ];
      return { schema: "fmc-recipe/0.1", family: `FMC_${role}_Part_SpeechGrille`, template: "Metric Generic Model.rft", ops, values: PART_VALUES, checks: PART_CHECKS,
        about: "Round speech grille 140 mm (QS03 component): on the interior face of a dispensing hatch's fixed glass." };
    },
  },
});

const WINDOW_NEED = ["Frame Int", "Frame Ext", "Frame L In", "Frame R In", "Sill Inner", "Head Inner"];

/**
 * Materials the standard recipes name that the kit doesn't have yet (rule 7: kit data only), and the kit material the
 * detailed recipe uses until the BIM Manager adds them (each raised with fmc_material request).
 */
export const KIT_SUBSTITUTES: Record<string, { use: string; why: string }> = {
  FMC_Fabric_Blind_Venetian_White: { use: "FMC_Plastic_ABS_White", why: "white venetian slats (PVC or aluminium); requested 19 Oct (FMC_Material_Requests.csv)" },
};

/** A recipe's add_material ops with any missing kit material swapped, and a value row saying so. */
export function substituteMaterials(ops: Op[]): { ops: Op[]; values: Record<string, any>; notes: string[] } {
  const values: Record<string, any> = {}, notes: string[] = [];
  const out = ops.map((o) => {
    const sub = o.op === "add_material" ? KIT_SUBSTITUTES[o.name] : undefined;
    if (!sub) return o;
    values[o.param ?? o.name] = { value: sub.use, source_status: "assumed", source: `${o.name} isn't in the kit yet: ${sub.why}` };
    notes.push(`${o.name} → ${sub.use} until the kit has it`);
    return { ...o, name: sub.use };
  });
  return { ops: out, values, notes };
}

/**
 * A wgen window → its detailed recipe, by what it has:
 *   - an integral blind: Open raises it to a 60 mm stack under the head (Blind Stack); the control knob becomes a
 *     component on the knob planes;
 *   - a dispensing hatch (a Shelf and one Glass): the glass splits into a fixed light and a hatch panel in its own
 *     planes; Open slides the panel up behind the fixed light (Hatch Height); a speech grille and a roller-shutter box.
 * Every window gets the working-zone clearance (500 mm in front of the interior face, assumed).
 */
export function detailWindow(std: RecipeLike, componentPath: (family: string) => string): DetailResult {
  const role = (/^FMC_([A-Z]{1,2})_/.exec(std.family) ?? [])[1] ?? "A";
  const planeNames = new Set(std.ops.filter((o) => o.op === "add_ref_plane").map((o) => String(o.name)));
  const missing = WINDOW_NEED.filter((p) => !planeNames.has(p));
  if (missing.length) throw new Error(`${std.family} isn't a wgen window: no plane ${missing.join(", ")}`);
  const solid = (n: string) => std.ops.find((o) => o.op === "extrusion" && o.name === n);
  const types = std.ops.filter((o) => o.op === "add_type").map((o) => String(o.name));
  const swapped = substituteMaterials(std.ops);
  const notes: string[] = [...swapped.notes];
  const components: string[] = [];
  let ops = swapped.ops;
  const add: Op[] = [
    { op: "add_family_param", name: "Open", type: "YesNo", group: "Constraints", instance: true },
    ...types.map((t) => ({ op: "set_type_value", name: `${t}/Open`, type: t, param: "Open", value: false })),
    { op: "add_family_param", name: "Closed", type: "YesNo", group: "Constraints", instance: true },
    { op: "set_formula", name: "Closed", formula: "not(Open)" },
  ];

  if (solid("Integral Blind")) {
    add.push(
      { op: "add_family_param", name: "Blind Down", type: "YesNo", group: "Constraints", instance: true },
      { op: "set_formula", name: "Blind Down", formula: "and(Show Blind, not(Open))" },
      { op: "add_family_param", name: "Blind Up", type: "YesNo", group: "Constraints", instance: true },
      { op: "set_formula", name: "Blind Up", formula: "and(Show Blind, Open)" },
      { op: "add_family_param", name: "Blind Stack", type: "Length", group: "Dimensions" },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Blind Stack`, type: t, param: "Blind Stack", value: 60 })),
      { op: "add_ref_plane", name: "Blind Stack Bottom", from: [-2500, 1578], to: [2500, 1578], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Blind Stack", between: ["Blind Stack Bottom", "Spacer Top"], label: "Blind Stack", view: "Exterior" },
      { op: "extrusion", name: "Integral Blind Up", rect: ["Spacer L", "Spacer R", "Blind Front", "Blind Back"], start: 1578, end: 1638, start_plane: "Blind Stack Bottom", end_plane: "Spacer Top" },
      { op: "set_subcategory", name: "Integral Blind Up", subcategory: "Blind" },
      { op: "set_material_param", name: "Integral Blind Up", param: "Blind Material" },
      { op: "set_visible_param", name: "Integral Blind Up/Visible", solid: "Integral Blind Up", param: "Blind Up" },
    );
    ops = ops.filter((o) => !(o.op === "set_visible_param" && o.solid === "Integral Blind"));
    add.push({ op: "set_visible_param", name: "Integral Blind/Visible", solid: "Integral Blind", param: "Blind Down" });
    if (solid("Blind Control Knob")) {
      const knob = COMPONENTS.blind_knob.family(role);
      ops = withoutSolids(ops, (n) => n === "Blind Control Knob");
      add.push({ op: "load_family", name: knob, path: componentPath(knob) },
        // turned round to stand out from the interior face; its edge (-15 in the knob) on Knob R once turned
        { op: "place_nested", name: "Blind Control Knob", family: knob, type: knob, rotate_deg: 180,
          lock: { x: { plane: "Knob R", ref: "Left", at: -15 }, y: { plane: "Frame Int", ref: "Back" }, z: { plane: "Knob Bot", ref: "Bottom", at: -15 } } },
        { op: "set_visible_param", name: "Blind Control Knob/Visible", solid: "Blind Control Knob", param: "Show Blind" });
      components.push(knob);
    }
    notes.push("Open raises the integral blind to a 60 mm stack under the head; Closed lowers it");
  }

  if (/Laboratory/.test(std.family) && solid("Glass")) {
    // the PassHatch type: a stainless pass-through box through the wall, 450 wide, 400 high, on the sill; two doors,
    // the exterior one always shut (interlocked), the interior one dropped open on its bottom hinge when Open
    const glass = solid("Glass")!;
    const sub = std.ops.find((o) => o.op === "set_subcategory" && o.name === "Glass")?.subcategory ?? "Glass";
    const gmat = std.ops.find((o) => o.op === "set_material_param" && o.name === "Glass")?.param ?? "Glass Material";
    const knob = COMPONENTS.blind_knob.family(role);
    const passType = types.filter((t) => /Pass/i.test(t));
    // stainless: the family's own stainless parameter when it has one (a material is added once per family)
    const steel = "FMC_Metal_StainlessSteel_Brushed";
    const ownSteel = ops.find((o) => o.op === "add_material" && o.name === steel)?.param as string | undefined;
    const boxMat = ownSteel ?? "Pass Box Material";
    const box = (name: string, rect: string[], start: number, end: number, sp: string, ep: string, sw: string, material = boxMat): Op[] => [
      { op: "extrusion", name, rect, start, end, start_plane: sp, end_plane: ep },
      { op: "set_subcategory", name, subcategory: "Pass Box" },
      { op: "set_material_param", name, param: material },
      { op: "set_visible_param", name: `${name}/Visible`, solid: name, param: sw },
    ];
    ops = ops.filter((o) => !(o.op === "set_visible_param" && o.solid === "Glass"));
    add.push(
      { op: "add_family_param", name: "Pass Hatch", type: "YesNo", group: "Constraints" },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Pass Hatch`, type: t, param: "Pass Hatch", value: passType.includes(t) })),
      { op: "add_family_param", name: "No Pass Hatch", type: "YesNo", group: "Constraints" },
      { op: "set_formula", name: "No Pass Hatch", formula: "not(Pass Hatch)" },
      { op: "add_family_param", name: "Pass Door Shut", type: "YesNo", group: "Constraints", instance: true },
      { op: "set_formula", name: "Pass Door Shut", formula: "and(Pass Hatch, not(Open))" },
      { op: "add_family_param", name: "Pass Door Open", type: "YesNo", group: "Constraints", instance: true },
      { op: "set_formula", name: "Pass Door Open", formula: "and(Pass Hatch, Open)" },
      { op: "add_subcategory", name: "Pass Box", line_weight_projection: 2 },
      ...(ownSteel ? [] : [{ op: "add_family_param", name: "Pass Box Material", type: "Material", group: "Materials" }, { op: "add_material", name: steel, param: "Pass Box Material" }]),
      ...["Box Width", "Box Height", "Box Lip", "Pass Door Thickness", "Pass Handle Height"].map((n) => ({ op: "add_family_param", name: n, type: "Length", group: "Dimensions" })),
      ...types.flatMap((t) => [["Box Width", 450], ["Box Height", 400], ["Box Lip", 30], ["Pass Door Thickness", 6], ["Pass Handle Height", 330]]
        .map(([n, v]) => ({ op: "set_type_value", name: `${t}/${n}`, type: t, param: n, value: v }))),
      { op: "add_ref_plane", name: "Box L", from: [-225, -1500], to: [-225, 1500], is_reference: "WeakReference" },
      { op: "add_ref_plane", name: "Box R", from: [225, -1500], to: [225, 1500], is_reference: "WeakReference" },
      { op: "add_dimension", name: "Box Width", between: ["Box L", "Box R"], label: "Box Width" },
      { op: "add_eq_dimension", name: "Box Width EQ", planes: ["Box L", "Center (Left/Right)", "Box R"] },
      { op: "add_ref_plane", name: "Box Out Ext", from: [-2500, -80], to: [2500, -80], is_reference: "WeakReference" },
      { op: "add_dimension", name: "Box Lip Ext", between: ["Box Out Ext", "Frame Ext"], label: "Box Lip" },
      { op: "add_ref_plane", name: "Box Out Int", from: [-2500, 80], to: [2500, 80], is_reference: "WeakReference" },
      { op: "add_dimension", name: "Box Lip Int", between: ["Frame Int", "Box Out Int"], label: "Box Lip" },
      { op: "add_ref_plane", name: "Box Top", from: [-2500, 1250], to: [2500, 1250], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Box Height", between: ["Sill Inner", "Box Top"], label: "Box Height", view: "Exterior" },
      { op: "add_ref_plane", name: "Pass Door Ext In", from: [-2500, -74], to: [2500, -74], is_reference: "WeakReference" },
      { op: "add_dimension", name: "Pass Door Ext", between: ["Box Out Ext", "Pass Door Ext In"], label: "Pass Door Thickness" },
      { op: "add_ref_plane", name: "Pass Door Int In", from: [-2500, 74], to: [2500, 74], is_reference: "WeakReference" },
      { op: "add_dimension", name: "Pass Door Int", between: ["Pass Door Int In", "Box Out Int"], label: "Pass Door Thickness" },
      { op: "add_ref_plane", name: "Pass Door Open Tip", from: [-2500, 480], to: [2500, 480], is_reference: "WeakReference" },
      { op: "add_dimension", name: "Pass Door Open Reach", between: ["Box Out Int", "Pass Door Open Tip"], label: "Box Height" },
      { op: "add_ref_plane", name: "Pass Door Open Bottom", from: [-2500, 844], to: [2500, 844], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Pass Door Open Thickness", between: ["Pass Door Open Bottom", "Sill Inner"], label: "Pass Door Thickness", view: "Exterior" },
      { op: "add_ref_plane", name: "Pass Handle", from: [-2500, 1180], to: [2500, 1180], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Pass Handle Height", between: ["Sill Inner", "Pass Handle"], label: "Pass Handle Height", view: "Exterior" },
      // the box: two cheeks and a top, so it reads as a box through the wall; the doors in its faces
      ...box("Pass Box Top", ["Box L", "Box R", "Box Out Ext", "Box Out Int"], 1240, 1250, "Box Top", "Box Top", "Pass Hatch"),
      ...box("Pass Box Base", ["Box L", "Box R", "Box Out Ext", "Box Out Int"], 850, 860, "Sill Inner", "Sill Inner", "Pass Hatch"),
      ...box("Pass Door Ext", ["Box L", "Box R", "Box Out Ext", "Pass Door Ext In"], 850, 1250, "Sill Inner", "Box Top", "Pass Hatch"),
      ...box("Pass Door Int", ["Box L", "Box R", "Pass Door Int In", "Box Out Int"], 850, 1250, "Sill Inner", "Box Top", "Pass Door Shut"),
      ...box("Pass Door Int Open", ["Box L", "Box R", "Box Out Int", "Pass Door Open Tip"], 844, 850, "Pass Door Open Bottom", "Sill Inner", "Pass Door Open"),
      // the glass: the whole light for the Fixed type; above the box for the PassHatch type
      { op: "set_visible_param", name: "Glass/Visible", solid: "Glass", param: "No Pass Hatch" },
      { op: "extrusion", name: "Glass Above Box", rect: glass.rect, start: 1250, end: Number(glass.end ?? 1950), start_plane: "Box Top", end_plane: String(glass.end_plane ?? "Head Inner") },
      { op: "set_subcategory", name: "Glass Above Box", subcategory: sub },
      { op: "set_material_param", name: "Glass Above Box", param: gmat },
      { op: "set_visible_param", name: "Glass Above Box/Visible", solid: "Glass Above Box", param: "Pass Hatch" },
      // a handle on each door (the interior one only while shut)
      { op: "load_family", name: knob, path: componentPath(knob) },
      { op: "place_nested", name: "Pass Handle Ext", family: knob, type: knob,
        lock: { x: { plane: "Center (Left/Right)", ref: "CenterLeftRight" }, y: { plane: "Box Out Ext", ref: "Back" }, z: { plane: "Pass Handle", ref: "Bottom", at: -15 } } },
      { op: "set_visible_param", name: "Pass Handle Ext/Visible", solid: "Pass Handle Ext", param: "Pass Hatch" },
      { op: "place_nested", name: "Pass Handle Int", family: knob, type: knob, rotate_deg: 180,
        lock: { x: { plane: "Center (Left/Right)", ref: "CenterLeftRight" }, y: { plane: "Box Out Int", ref: "Back" }, z: { plane: "Pass Handle", ref: "Bottom", at: -15 } } },
      { op: "set_visible_param", name: "Pass Handle Int/Visible", solid: "Pass Handle Int", param: "Pass Door Shut" },
    );
    if (!components.includes(knob)) components.push(knob);
    notes.push(`the ${passType.join(", ") || "PassHatch"} type has a stainless pass-through box; Open drops its interior door on its bottom hinge; the Fixed type keeps the whole light`);
  } else if (solid("Shelf") && solid("Glass")) {
    const glass = solid("Glass")!;
    ops = withoutSolids(ops, (n) => n === "Glass");
    const sub = std.ops.find((o) => o.op === "set_subcategory" && o.name === "Glass")?.subcategory ?? "Glass";
    const mat = std.ops.find((o) => o.op === "set_material_param" && o.name === "Glass")?.param ?? "Glass Material";
    const pane = (name: string, rect: string[], start: number, end: number, sp: string, ep: string, sw?: string): Op[] => [
      { op: "extrusion", name, rect, start, end, start_plane: sp, end_plane: ep },
      { op: "set_subcategory", name, subcategory: sub },
      { op: "set_material_param", name, param: mat },
      ...(sw ? [{ op: "set_visible_param", name: `${name}/Visible`, solid: name, param: sw }] : []),
    ];
    const grille = COMPONENTS.speech_grille.family(role);
    add.push(
      { op: "add_family_param", name: "Hatch Height", type: "Length", group: "Dimensions" },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Hatch Height`, type: t, param: "Hatch Height", value: 300 })),
      { op: "add_ref_plane", name: "Hatch Top", from: [-2500, 1150], to: [2500, 1150], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Hatch Height", between: ["Sill Inner", "Hatch Top"], label: "Hatch Height", view: "Exterior" },
      { op: "add_ref_plane", name: "Hatch Open Top", from: [-2500, 1450], to: [2500, 1450], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Hatch Open Height", between: ["Hatch Top", "Hatch Open Top"], label: "Hatch Height", view: "Exterior" },
      { op: "add_ref_plane", name: "Hatch Ext", from: [-2500, 6], to: [2500, 6], is_reference: "WeakReference" },
      { op: "add_ref_plane", name: "Hatch Int", from: [-2500, 12], to: [2500, 12], is_reference: "WeakReference" },
      ...pane("Glass Fixed", glass.rect, 1150, Number(glass.end ?? 1350), "Hatch Top", String(glass.end_plane ?? "Head Inner")),
      ...pane("Hatch Panel", [glass.rect[0], glass.rect[1], "Hatch Ext", "Hatch Int"], 850, 1150, "Sill Inner", "Hatch Top", "Closed"),
      ...pane("Hatch Panel Open", [glass.rect[0], glass.rect[1], "Hatch Ext", "Hatch Int"], 1150, 1450, "Hatch Top", "Hatch Open Top", "Open"),
      { op: "add_family_param", name: "Grille Above Hatch", type: "Length", group: "Dimensions" },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Grille Above Hatch`, type: t, param: "Grille Above Hatch", value: 150 })),
      { op: "add_ref_plane", name: "Grille Mid", from: [-2500, 1300], to: [2500, 1300], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Grille Above Hatch", between: ["Hatch Top", "Grille Mid"], label: "Grille Above Hatch", view: "Exterior" },
      { op: "load_family", name: grille, path: componentPath(grille) },
      { op: "place_nested", name: "Speech Grille", family: grille, type: grille, rotate_deg: 180,
        lock: { x: { plane: "Center (Left/Right)", ref: "CenterLeftRight" }, y: { plane: "Glass Int", ref: "Back" }, z: { plane: "Grille Mid", ref: "CenterElevation" } } },
      { op: "add_family_param", name: "Shutter Box Height", type: "Length", group: "Dimensions" },
      ...types.map((t) => ({ op: "set_type_value", name: `${t}/Shutter Box Height`, type: t, param: "Shutter Box Height", value: 160 })),
      { op: "add_ref_plane", name: "Shutter Box Top", from: [-2500, 1630], to: [2500, 1630], view: "Exterior", is_reference: "WeakReference" },
      { op: "add_dimension", name: "Shutter Box Height", between: ["Arch Top", "Shutter Box Top"], label: "Shutter Box Height", view: "Exterior" },
      { op: "add_ref_plane", name: "Shutter Box In", from: [-2500, 230], to: [2500, 230], is_reference: "WeakReference" },
      { op: "extrusion", name: "Shutter Box", rect: ["Arch L", "Arch R", "Frame Int", "Shutter Box In"], start: 1470, end: 1630, start_plane: "Arch Top", end_plane: "Shutter Box Top" },
      { op: "set_subcategory", name: "Shutter Box", subcategory: "Frame" },
      { op: "set_material_param", name: "Shutter Box", param: "Frame Material" },
    );
    components.push(grille);
    notes.push("Open slides the hatch panel up behind the fixed light; a speech grille 150 mm above the hatch; a 160 mm roller-shutter box over the architrave");
  }

  const clr = clearanceOps(std, { face: "Frame Int", side: 1, from: "Left", to: "Right", depth: 500, param: "Clearance Working Zone",
    why: "standing zone in front of a hospital window or hatch; confirm (owner or engineer)" });
  add.push(...clr.ops);

  const at = ops.map((o) => o.op).lastIndexOf("set_type_value") + 1;
  return {
    recipe: { ...std, family: `${std.family}_Detailed`, ops: [...ops.slice(0, at), ...add, ...ops.slice(at)], values: { ...(std.values ?? {}), ...swapped.values, ...clr.value },
      about: `Detailed window (QS03 generator, ${new Date().toISOString().slice(0, 10)}): ${std.family}; ${notes.join("; ")}; working-zone clearance; instance switch Open.` },
    components,
    notes,
  };
}
