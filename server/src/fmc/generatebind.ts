/**
 * fmc_generate_bind: one call that generates a door or window family with front and back legend geometry and the
 * eleven Sinko-style shared parameters bound (fmc/sinkoparams.ts), ready for a legend view and a legend-schedule row.
 *
 * This module is pure: it turns the call into an fmc-recipe/0.1 recipe (the same ops fmc_recipe builds, so the build,
 * flex, staging save and Gate A are the recipe pipeline's, not a second family builder), the legend-schedule rows and
 * the legend placement that follows. It reads no file and talks to no Revit; the tool (tools/fmc_generate_bind.ts)
 * does the dry run, the guard and the build.
 *
 * Geometry, all locked to reference planes so every type flexes: two jambs, a head (and a sill rail for a window) on
 * the Frame subcategory, a leaf (door, Panel) or a glass pane (window, Glass). Legend geometry: the opening
 * indication drawn as symbolic lines in the front/back elevation plane twice, once on "Legend Front" (exterior face)
 * and once on "Legend Back" (interior face, dashed), every end on two planes so the lines follow Width and Height.
 * A legend component set to Elevation: Front shows the exterior; Elevation: Back the interior, where Revit mirrors the
 * same lines so the hinge stays on its true side. Each legend view hides the other face's subcategory.
 */
import crypto from "node:crypto";
import type { SpParam } from "./specs.js";
import { LEGEND_VIEW } from "./legendmath.js";
import { SINKO_BUILTIN_COLUMNS, SINKO_COUNT, SINKO_PARAMS, type OpeningKind, type SinkoParam } from "./sinkoparams.js";

export const GB_TOOL = "fmc_generate_bind";

export const DOOR_OPERATIONS = ["hinged_left", "hinged_right"] as const;
export const WINDOW_OPERATIONS = ["fixed", "casement_left", "casement_right", "top_hung", "bottom_hung", "sliding"] as const;
export type Operation = typeof DOOR_OPERATIONS[number] | typeof WINDOW_OPERATIONS[number];
export type SinkoValue = string | number | boolean;

export interface GbType {
  name?: string;
  width_mm: number;
  height_mm: number;
  type_mark?: string;
  keynote?: string;
  values?: Record<string, SinkoValue>;
}

export interface GbInput {
  kind: OpeningKind;
  /** FMC_A_Door_<Description> / FMC_A_Window_<Description>; built from description when left out. */
  family?: string;
  description?: string;
  operation?: Operation;
  types: GbType[];
  frame_width_mm?: number;
  frame_depth_mm?: number;
  leaf_thickness_mm?: number;
  sill_height_mm?: number;
  /** Sinko values for every type (a type's own values win). */
  values?: Record<string, SinkoValue>;
  /** Where the values came from (recipe values: verified, EA, assumed, pending). */
  source_status?: "verified" | "EA" | "assumed" | "pending";
  source?: string;
}

export interface ResolvedSinko extends SinkoParam {
  guid: string;
  datatype: string;
  formula?: string;
}

export interface LegendRow {
  family: string;
  type: string;
  cells: Record<string, string | number | boolean>;
}

export interface GbPlan {
  family: string;
  kind: OpeningKind;
  operation: Operation;
  template: string;
  recipe: Record<string, any>;
  sinko: ResolvedSinko[];
  legend_rows: LegendRow[];
  legend_geometry: Array<{ face: "front" | "back"; subcategory: string; set: string; lines: number; at_mm: number }>;
  legend_place: Record<string, unknown>;
  problems: string[];
  notes: string[];
}

export const LEGEND_FRONT = "Legend Front";
export const LEGEND_BACK = "Legend Back";
export const TEMPLATES: Record<OpeningKind, string> = { door: "Metric Door.rft", window: "Metric Window.rft" };
/** The elevation view the template names for drawing level planes (the existing recipes use these). */
const ELEV_VIEW: Record<OpeningKind, string> = { door: "Front", window: "Exterior" };
/** The template's own planes: Left/Right (Width), Head (Height), and Sill for a window. */
export const TEMPLATE_PLANES: Record<OpeningKind, string[]> = {
  door: ["Left", "Right", "Head", "Ref. Level", "Center (Left/Right)"],
  window: ["Left", "Right", "Head", "Sill", "Ref. Level", "Center (Left/Right)"],
};

const FAMILY_RE = /^FMC_[A-Za-z0-9]+_[A-Za-z0-9]+_[A-Za-z0-9_]+$/;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pad4 = (n: number) => String(Math.round(n)).padStart(4, "0");

export function typeName(t: GbType): string {
  return (t.name ?? "").trim() || `${pad4(t.width_mm)}x${pad4(t.height_mm)}`;
}

export function familyName(input: Pick<GbInput, "kind" | "family" | "description" | "operation">): string {
  const given = (input.family ?? "").trim();
  if (given) return given;
  const token = input.kind === "door" ? "Door" : "Window";
  const raw = (input.description ?? "").trim() || `Legend_${input.operation ?? (input.kind === "door" ? "hinged_left" : "casement_left")}`;
  const desc = raw.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Legend";
  return `FMC_A_${token}_${desc}`;
}

/** The eleven parameters with GUID and data type from the kit file (never from code). */
export function resolveSinko(dictionary: Map<string, SpParam> | null, kitFile = ""): { params: ResolvedSinko[]; problems: string[] } {
  const problems: string[] = [];
  if (SINKO_PARAMS.length !== SINKO_COUNT) problems.push(`[FMC-GB-SINKO-COUNT] fmc/sinkoparams.ts lists ${SINKO_PARAMS.length} parameters, not ${SINKO_COUNT}.`);
  if (!dictionary) {
    problems.push(`[FMC-PARAM-FILE] The kit shared parameter file is not readable at ${kitFile || "(not set)"}. Nothing was invented.`);
    return { params: [], problems };
  }
  const params: ResolvedSinko[] = [];
  for (const p of SINKO_PARAMS) {
    const found = dictionary.get(p.name);
    if (!found) {
      problems.push(`[FMC-PARAM-NOT-IN-KIT] "${p.name}" is not in the kit shared parameter file. Kit change: add it to FMC_SharedParameters.txt. No definition was created.`);
      continue;
    }
    params.push({ ...p, guid: found.guid, datatype: found.datatype.toUpperCase() });
  }
  return { params, problems };
}

/** A value checked against the kit data type; null with a problem when it does not fit. */
export function coerceValue(p: { name: string; datatype: string }, v: SinkoValue): { value: SinkoValue | null; problem?: string } {
  const dt = p.datatype.toUpperCase();
  const bad = (want: string) => ({ value: null, problem: `[FMC-GB-VALUE] ${p.name} is ${dt} in the kit file: ${JSON.stringify(v)} is not ${want}.` });
  if (dt === "TEXT" || dt === "MULTILINETEXT") return { value: String(v) };
  if (dt === "YESNO") {
    if (typeof v === "boolean") return { value: v };
    const s = String(v).trim().toLowerCase();
    if (["yes", "true", "1"].includes(s)) return { value: true };
    if (["no", "false", "0"].includes(s)) return { value: false };
    return bad("yes or no");
  }
  if (dt === "INTEGER") {
    const n = typeof v === "number" ? v : Number(String(v).trim());
    return Number.isInteger(n) ? { value: n } : bad("a whole number");
  }
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? { value: n } : bad("a number");
}

/** Type formulas for the area columns, from the geometry, so the schedule can't disagree with the model. */
export function sinkoFormulas(kind: OpeningKind, operation: Operation): Record<string, string> {
  const clearW = "(Width - 2 * Frame Width)";
  if (kind === "door") {
    // A solid leaf: no glazing unless the call gives a value; the clear opening is the openable area.
    return { FMC_Openable_Area_m2: `${clearW} * (Height - Frame Width)` };
  }
  const glazed = `${clearW} * (Height - 2 * Frame Width)`;
  const factor = operation === "fixed" ? " * 0" : operation === "sliding" ? " * 0.5" : "";
  return { FMC_Glazed_Area_m2: glazed, FMC_Openable_Area_m2: `${glazed}${factor}` };
}

type End = { planes: [string, string] };
const at = (a: string, b: string): End => ({ planes: [a, b] });

/** The opening indication as plane-locked lines in the elevation plane (empty for fixed glazing). */
export function legendLines(kind: OpeningKind, operation: Operation): Array<{ from: End; to: End }> {
  const L = "Frame L In", R = "Frame R In", MV = "Opening Mid V", MH = "Opening Mid H", TOP = "Head Inner";
  const BOT = kind === "door" ? "Door Floor" : "Sill Inner";
  // Hinged and casement: two lines from the lock-side corners to the middle of the hinge side.
  const hinged = (hinge: string, lock: string) => [{ from: at(lock, BOT), to: at(hinge, MH) }, { from: at(hinge, MH), to: at(lock, TOP) }];
  switch (operation) {
    case "hinged_left": case "casement_left": return hinged(L, R);
    case "hinged_right": case "casement_right": return hinged(R, L);
    case "top_hung": return [{ from: at(L, BOT), to: at(MV, TOP) }, { from: at(MV, TOP), to: at(R, BOT) }];
    case "bottom_hung": return [{ from: at(L, TOP), to: at(MV, BOT) }, { from: at(MV, BOT), to: at(R, TOP) }];
    case "sliding": return [{ from: at(L, MH), to: at(R, MH) }];
    case "fixed": default: return [];
  }
}

export function validOperation(kind: OpeningKind, op: string | undefined): op is Operation {
  return op == null || (kind === "door" ? (DOOR_OPERATIONS as readonly string[]) : (WINDOW_OPERATIONS as readonly string[])).includes(op);
}

/** Everything the call would create, as a recipe plus the legend rows: no file, no Revit. */
export function planGenerateBind(input: GbInput, dictionary: Map<string, SpParam> | null, kitFile = ""): GbPlan {
  const problems: string[] = [];
  const notes: string[] = [];
  const kind = input.kind;
  const operation: Operation = input.operation ?? (kind === "door" ? "hinged_left" : "casement_left");
  if (!validOperation(kind, input.operation)) {
    problems.push(`[FMC-GB-OPERATION] ${input.operation} is not a ${kind} operation: ${(kind === "door" ? DOOR_OPERATIONS : WINDOW_OPERATIONS).join(", ")}.`);
  }
  const family = familyName({ ...input, operation });
  const token = kind === "door" ? "Door" : "Window";
  if (!FAMILY_RE.test(family)) problems.push(`[FMC-GB-NAME] "${family}" does not follow FMC_<Role>_<Token>_<Description>.`);
  else if (family.split("_")[2] !== token) problems.push(`[FMC-GB-NAME] "${family}" must carry the ${token} token for a ${kind} (FMC_A_${token}_<Description>).`);
  if (/hebert|a-0001/i.test(family)) problems.push(`[FMC-GB-GUARD] "${family}" names a protected project. A library family is not named after a project.`);

  const fw = input.frame_width_mm ?? (kind === "door" ? 40 : 50);
  const fd = input.frame_depth_mm ?? 100;
  const lt = input.leaf_thickness_mm ?? 45;
  const sill = kind === "window" ? input.sill_height_mm ?? 800 : 0;
  if (!(fw > 0) || !(fd > 0) || (kind === "door" && !(lt > 0))) problems.push("[FMC-GB-SIZE] frame_width_mm, frame_depth_mm and leaf_thickness_mm must be more than 0.");
  if (kind === "door" && lt >= fd) problems.push(`[FMC-GB-SIZE] the leaf (${lt} mm) must be thinner than the frame depth (${fd} mm).`);

  const types = input.types ?? [];
  if (!types.length) problems.push("[FMC-GB-TYPES] Give at least one type: width_mm and height_mm.");
  if (types.length > 20) problems.push(`[FMC-GB-TYPES] ${types.length} types; at most 20 in one call.`);
  const names = new Set<string>();
  for (const t of types) {
    const n = typeName(t);
    if (names.has(n.toLowerCase())) problems.push(`[FMC-GB-TYPES] Type "${n}" is given twice.`);
    names.add(n.toLowerCase());
    if (!(t.width_mm > 2 * fw + 100) || !(t.height_mm > 2 * fw + 100)) {
      problems.push(`[FMC-GB-SIZE] Type "${n}": ${t.width_mm} x ${t.height_mm} mm leaves no opening inside a ${fw} mm frame.`);
    }
  }

  const { params: sinko, problems: kitProblems } = resolveSinko(dictionary, kitFile);
  problems.push(...kitProblems);
  const formulas = sinkoFormulas(kind, operation);
  for (const p of sinko) if (formulas[p.name] && p.source === "formula") p.formula = formulas[p.name];
  const byName = new Map(sinko.map((p) => [p.name.toLowerCase(), p]));
  const checkValues = (vals: Record<string, SinkoValue> | undefined, where: string) => {
    const out = new Map<string, SinkoValue>();
    for (const [k, v] of Object.entries(vals ?? {})) {
      const p = byName.get(k.trim().toLowerCase());
      if (!p) {
        if (SINKO_PARAMS.some((s) => s.name.toLowerCase() === k.trim().toLowerCase())) continue; // already a kit problem
        problems.push(`[FMC-GB-VALUE] ${where}: "${k}" is not one of the eleven legend parameters (${SINKO_PARAMS.map((s) => s.name).join(", ")}).`);
        continue;
      }
      if (p.formula) { problems.push(`[FMC-GB-VALUE] ${where}: ${p.name} is a formula from the geometry (${p.formula}); it takes no value.`); continue; }
      const c = coerceValue(p, v);
      if (c.problem) problems.push(`${c.problem} (${where})`);
      else out.set(p.name, c.value as SinkoValue);
    }
    return out;
  };
  const common = checkValues(input.values, "values");

  const first = types[0] ?? { width_mm: kind === "door" ? 900 : 1200, height_mm: kind === "door" ? 2100 : 1200 };
  const W = first.width_mm, H = first.height_mm;
  const span = W / 2 + 600;
  const ev = ELEV_VIEW[kind];
  const ops: Array<Record<string, unknown>> = [];
  const push = (o: Record<string, unknown>) => ops.push(o);

  push({ op: "set_category", name: kind === "door" ? "OST_Doors" : "OST_Windows" });
  // F-026: the first type's size is current before any plane is drawn
  push({ op: "set_default_size", name: "Default size", type: typeName(first), values: { Width: W, Height: H } });
  // kit parameters (rule 7: GUIDs from the kit file), all type parameters for the legend
  for (const p of sinko) push({ op: "add_shared_param", name: p.name, guid: p.guid, instance: false, group: p.group });
  // family parameters
  push({ op: "add_family_param", name: "Frame Width", type: "Length", group: "Dimensions" });
  push({ op: "add_family_param", name: "Frame Depth", type: "Length", group: "Dimensions" });
  if (kind === "door") push({ op: "add_family_param", name: "Leaf Thickness", type: "Length", group: "Dimensions" });
  push({ op: "add_family_param", name: "Frame Material", type: "Material", group: "Materials" });
  push({ op: "add_family_param", name: kind === "door" ? "Panel Material" : "Glass Material", type: "Material", group: "Materials" });
  // subcategories: model graphics and the two legend faces
  const fill = kind === "door" ? "Panel" : "Glass";
  push({ op: "add_subcategory", name: "Frame", line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0] });
  push({ op: "add_subcategory", name: fill, line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0] });
  push({ op: "add_subcategory", name: LEGEND_FRONT, line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0] });
  push({ op: "add_subcategory", name: LEGEND_BACK, line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0], line_pattern: "Dash" });
  // planes
  push({ op: "add_ref_plane", name: "Wall Centre", from: [-span, 0], to: [span, 0], is_reference: "CenterFrontBack" });
  push({ op: "add_ref_plane", name: "Frame Ext", from: [-span, r1(-fd / 2)], to: [span, r1(-fd / 2)], is_reference: "StrongReference" });
  push({ op: "add_ref_plane", name: "Frame Int", from: [-span, r1(fd / 2)], to: [span, r1(fd / 2)], is_reference: "StrongReference" });
  push({ op: "add_ref_plane", name: "Frame L In", from: [r1(-W / 2 + fw), -1000], to: [r1(-W / 2 + fw), 1000], is_reference: "WeakReference" });
  push({ op: "add_ref_plane", name: "Frame R In", from: [r1(W / 2 - fw), -1000], to: [r1(W / 2 - fw), 1000], is_reference: "WeakReference" });
  push({ op: "add_ref_plane", name: "Opening Mid V", from: [0, -1000], to: [0, 1000], is_reference: "WeakReference" });
  push({ op: "add_ref_plane", name: "Head Inner", view: ev, from: [-span, r1(sill + H - fw)], to: [span, r1(sill + H - fw)], is_reference: "WeakReference" });
  if (kind === "window") {
    push({ op: "add_ref_plane", name: "Sill Inner", view: ev, from: [-span, r1(sill + fw)], to: [span, r1(sill + fw)], is_reference: "WeakReference" });
    push({ op: "add_ref_plane", name: "Opening Mid H", view: ev, from: [-span, r1(sill + H / 2)], to: [span, r1(sill + H / 2)], is_reference: "WeakReference" });
    push({ op: "add_ref_plane", name: "Glass Front", from: [-span, -3], to: [span, -3], is_reference: "WeakReference" });
    push({ op: "add_ref_plane", name: "Glass Back", from: [-span, 3], to: [span, 3], is_reference: "WeakReference" });
  } else {
    // the floor line the opening lines start from: the leaf sits on the level, so it never moves
    push({ op: "add_ref_plane", name: "Door Floor", view: ev, from: [-span, 0], to: [span, 0], is_reference: "WeakReference" });
    push({ op: "add_ref_plane", name: "Opening Mid H", view: ev, from: [-span, r1((H - fw) / 2)], to: [span, r1((H - fw) / 2)], is_reference: "WeakReference" });
    push({ op: "add_ref_plane", name: "Leaf Face Ext", from: [-span, r1(-lt / 2)], to: [span, r1(-lt / 2)], is_reference: "WeakReference" });
    push({ op: "add_ref_plane", name: "Leaf Face Int", from: [-span, r1(lt / 2)], to: [span, r1(lt / 2)], is_reference: "WeakReference" });
  }
  // labelled and equal dimensions: every plane follows the type's size
  push({ op: "add_dimension", name: "Frame Width L", between: ["Left", "Frame L In"], label: "Frame Width" });
  push({ op: "add_dimension", name: "Frame Width R", between: ["Frame R In", "Right"], label: "Frame Width" });
  push({ op: "add_dimension", name: "Frame Width Head", between: ["Head Inner", "Head"], label: "Frame Width", view: ev, offset: 700 });
  push({ op: "add_dimension", name: "Frame Depth", between: ["Frame Ext", "Frame Int"], label: "Frame Depth", offset: 600 });
  push({ op: "add_eq_dimension", name: "EQ frame depth", planes: ["Frame Ext", "Wall Centre", "Frame Int"] });
  push({ op: "add_eq_dimension", name: "EQ opening width", planes: ["Frame L In", "Opening Mid V", "Frame R In"], offset: -600 });
  if (kind === "window") {
    push({ op: "add_dimension", name: "Frame Width Sill", between: ["Sill", "Sill Inner"], label: "Frame Width", view: ev, offset: 700 });
    push({ op: "add_eq_dimension", name: "EQ opening height", planes: ["Sill Inner", "Opening Mid H", "Head Inner"], view: ev, offset: -700 });
  } else {
    push({ op: "add_dimension", name: "Leaf Thickness", between: ["Leaf Face Ext", "Leaf Face Int"], label: "Leaf Thickness" });
    push({ op: "add_eq_dimension", name: "EQ leaf", planes: ["Leaf Face Ext", "Wall Centre", "Leaf Face Int"] });
    push({ op: "add_eq_dimension", name: "EQ opening height", planes: ["Door Floor", "Opening Mid H", "Head Inner"], view: ev, offset: -700 });
  }
  // solids
  const bottom = kind === "window" ? { start: sill, start_plane: "Sill" } : { start: 0 };
  const top = sill + H;
  push({ op: "extrusion", name: "Jamb Left", rect: ["Left", "Frame L In", "Frame Ext", "Frame Int"], ...bottom, end: top, end_plane: "Head" });
  push({ op: "extrusion", name: "Jamb Right", rect: ["Frame R In", "Right", "Frame Ext", "Frame Int"], ...bottom, end: top, end_plane: "Head" });
  push({ op: "extrusion", name: "Head Rail", rect: ["Frame L In", "Frame R In", "Frame Ext", "Frame Int"], start: r1(top - fw), start_plane: "Head Inner", end: top, end_plane: "Head" });
  const frameSolids = ["Jamb Left", "Jamb Right", "Head Rail"];
  if (kind === "window") {
    push({ op: "extrusion", name: "Sill Rail", rect: ["Frame L In", "Frame R In", "Frame Ext", "Frame Int"], start: sill, start_plane: "Sill", end: r1(sill + fw), end_plane: "Sill Inner" });
    frameSolids.push("Sill Rail");
    push({ op: "extrusion", name: "Glass Pane", rect: ["Frame L In", "Frame R In", "Glass Front", "Glass Back"], start: r1(sill + fw), start_plane: "Sill Inner", end: r1(top - fw), end_plane: "Head Inner" });
  } else {
    push({ op: "extrusion", name: "Leaf", rect: ["Frame L In", "Frame R In", "Leaf Face Ext", "Leaf Face Int"], start: 10, end: r1(top - fw), end_plane: "Head Inner" });
  }
  const fillSolid = kind === "door" ? "Leaf" : "Glass Pane";
  for (const s of frameSolids) {
    push({ op: "set_subcategory", name: s, subcategory: "Frame" });
    push({ op: "set_material_param", name: s, param: "Frame Material" });
  }
  push({ op: "set_subcategory", name: fillSolid, subcategory: fill });
  push({ op: "set_material_param", name: fillSolid, param: kind === "door" ? "Panel Material" : "Glass Material" });
  // legend geometry: the same plane-locked opening lines on the exterior face (front) and the interior face (back)
  const lines = legendLines(kind, operation);
  const legend_geometry: GbPlan["legend_geometry"] = [];
  if (lines.length) {
    const faces: Array<["front" | "back", string, number]> = [["front", LEGEND_FRONT, r1(-fd / 2)], ["back", LEGEND_BACK, r1(fd / 2)]];
    for (const [face, sub, y] of faces) {
      const set = `${sub} ${operation}`;
      push({ op: "symbolic_lines", name: set, view: "front", at: y, lines, subcategory: sub });
      legend_geometry.push({ face, subcategory: sub, set, lines: lines.length, at_mm: y });
    }
  } else {
    notes.push("Fixed glazing has no opening lines: the front and back legends show the frame and the glass only.");
  }
  if (operation === "sliding") notes.push("Sliding: one line across the middle of the opening; the direction arrow is added by hand in the legend view if the office draws one.");
  // formulas for the area columns
  for (const p of sinko) if (p.formula) push({ op: "set_formula", name: p.name, formula: p.formula });

  // types and their values
  const legend_rows: LegendRow[] = [];
  const recipeValues: Record<string, { value: string | number; source_status: string; source?: string }> = {};
  const status = input.source_status ?? "assumed";
  recipeValues["Frame Width"] = { value: fw, source_status: status, ...(input.source ? { source: input.source } : {}) };
  recipeValues["Frame Depth"] = { value: fd, source_status: status, ...(input.source ? { source: input.source } : {}) };
  if (kind === "door") recipeValues["Leaf Thickness"] = { value: lt, source_status: status, ...(input.source ? { source: input.source } : {}) };
  types.forEach((t, i) => {
    const tn = typeName(t);
    push({ op: "add_type", name: tn });
    const set = (param: string, value: SinkoValue) => push({ op: "set_type_value", name: `${tn}/${param}`, type: tn, param, value });
    set("Width", t.width_mm);
    set("Height", t.height_mm);
    set("Frame Width", fw);
    set("Frame Depth", fd);
    if (kind === "door") set("Leaf Thickness", lt);
    const mark = (t.type_mark ?? "").trim() || `${kind === "door" ? "D" : "W"}${String(i + 1).padStart(2, "0")}`;
    set("Type Mark", mark);
    if ((t.keynote ?? "").trim()) set("Keynote", t.keynote!.trim());
    const own = checkValues(t.values, `type ${tn}`);
    const merged = new Map([...common, ...own]);
    const cells: LegendRow["cells"] = { "Type Mark": mark, Width: t.width_mm, Height: t.height_mm };
    for (const p of sinko) {
      if (p.formula) { cells[p.column] = `= ${p.formula}`; continue; }
      const v = merged.get(p.name);
      if (v === undefined) { cells[p.column] = ""; continue; }
      set(p.name, v);
      cells[p.column] = v;
      recipeValues[`${tn}/${p.name}`] = { value: typeof v === "boolean" ? (v ? "Yes" : "No") : v, source_status: status, ...(input.source ? { source: input.source } : {}) };
    }
    legend_rows.push({ family, type: tn, cells });
  });
  const blanks = new Set<string>();
  for (const row of legend_rows) for (const p of sinko) if (row.cells[p.column] === "") blanks.add(p.name);
  if (blanks.size) notes.push(`Bound but left blank (no value given): ${[...blanks].join(", ")}. The schedule shows them empty until a value is set.`);

  const template = TEMPLATES[kind];
  const recipe = {
    schema: "fmc-recipe/0.1",
    family,
    template,
    about: `Generated by ${GB_TOOL}: ${kind} (${operation}), frame ${fw} x ${fd} mm, front and back legend geometry on "${LEGEND_FRONT}" and "${LEGEND_BACK}", ` +
      `${sinko.length} Sinko-style kit parameters bound as type parameters (${sinko.map((p) => p.name).join(", ")}).`,
    ops,
    values: recipeValues,
    checks: {},
  };
  const legend_place = legendPlacement(family, kind, legend_rows.map((r) => r.type));
  return { family, kind, operation, template, recipe, sinko, legend_rows, legend_geometry, legend_place, problems, notes };
}

/** What follows once the family is loaded in a project: two legend views (front, back), one component per type each. */
export function legendPlacement(family: string, kind: OpeningKind, types: string[]): Record<string, unknown> {
  return {
    tool: "fmc_legend",
    action: "place",
    category: kind,
    views: [
      { face: "front", legend_view: `${family} - Elevation Front`, direction: LEGEND_VIEW.elevation_front, direction_name: "elevation_front", hide_subcategory: LEGEND_BACK },
      { face: "back", legend_view: `${family} - Elevation Back`, direction: LEGEND_VIEW.elevation_back, direction_name: "elevation_back", hide_subcategory: LEGEND_FRONT },
    ],
    types: types.map((t) => ({ family, type: t })),
    schedule_fields: [...SINKO_BUILTIN_COLUMNS, ...SINKO_PARAMS.map((p) => p.name)],
    steps: [
      "Load the staged family into the project (revit_file load_family) once a person has checked it; this call does not load it.",
      "fmc_legend create_view twice from a seed legend (front, back), then fmc_legend place with types [{id, category, view: front|back}].",
      `In the front legend view hide the "${LEGEND_BACK}" subcategory, in the back legend view hide "${LEGEND_FRONT}" (Visibility/Graphics).`,
      `Schedule the ${kind}s by type with the schedule_fields in this order and sort by Type Mark: one row per legend component.`,
    ],
  };
}

/** A stable id of what the dry run showed: the apply must name it, so the build is the plan that was shown. */
export function planId(recipe: Record<string, unknown>): string {
  return "gb-" + crypto.createHash("sha256").update(JSON.stringify(recipe)).digest("hex").slice(0, 16);
}
