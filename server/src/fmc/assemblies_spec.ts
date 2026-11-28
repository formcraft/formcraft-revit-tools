/**
 * F59 assemblies: the kit's fill and model patterns, curtain wall types, railing types and the legend that shows them.
 * The designs are the kit's (03_Master_Data\FMC_Assemblies.json, or `spec` in the call): every name, size and base
 * type is a design input; nothing here has a default. Pure: no Revit.
 */
import path from "node:path";

export type PatternTarget = "drafting" | "model";
export interface PatternGrid {
  /** degrees, anticlockwise from the x axis */
  angle: number;
  /** mm between lines (paper mm for drafting, model mm for model patterns) */
  spacing: number;
  /** mm along the line between rows (a stagger), optional */
  shift?: number;
  /** mm: the first line's origin, optional */
  origin?: [number, number];
}
export interface PatternSpec { name: string; target: PatternTarget; grids: PatternGrid[]; description?: string }

export const GRID_LAYOUTS = ["none", "fixed_distance", "fixed_number", "maximum_spacing", "minimum_spacing"] as const;
export type GridLayout = (typeof GRID_LAYOUTS)[number];
/** Revit's SPACING_LAYOUT_* values, by layout */
export const LAYOUT_CODE: Record<GridLayout, number> = { none: 0, fixed_distance: 1, fixed_number: 2, maximum_spacing: 3, minimum_spacing: 4 };
export interface CurtainGrid { layout: GridLayout; spacing?: number }
export interface CurtainSpec {
  name: string;
  /** an existing curtain wall type in the model to duplicate (e.g. the template's Storefront) */
  base: string;
  vertical: CurtainGrid;
  horizontal: CurtainGrid;
  /** mullion types by name (already in the model): interior and border, each optional */
  mullion?: { interior?: string; border?: string };
  /** the curtain panel type by name (already in the model), optional */
  panel?: string;
}
export interface RailingSpec {
  name: string;
  /** an existing railing type in the model to duplicate */
  base: string;
  /** top rail height, mm */
  height: number;
  /** the top rail type by name (already in the model), optional */
  top_rail?: string;
}
export interface LegendSpec { view: string; columns?: number }
export interface AssembliesSpec {
  revision?: string;
  patterns: PatternSpec[];
  curtain_walls: CurtainSpec[];
  railings: RailingSpec[];
  legend?: LegendSpec;
}

export const KIT_FILE_NAME = "FMC_Assemblies.json";
/** The kit's assembly designs sit with the master data: <kit>\03_Master_Data\FMC_Assemblies.json. */
export function kitAssembliesFile(materialsFile: string): string {
  return path.join(path.dirname(path.dirname(materialsFile)), "03_Master_Data", KIT_FILE_NAME);
}
export const KIT_REQUEST = {
  item: "Assembly designs (F59)",
  request: "Add 03_Master_Data\\FMC_Assemblies.json: patterns (name, drafting/model, grids of angle and spacing), curtain wall types " +
    "(base type, vertical and horizontal grid layout and spacing, mullion and panel types), railing types (base type, height, top rail) " +
    "and the legend view, from the Fam_* designs",
  why: "The kit has no assembly designs, so every call has to carry them; nothing is defaulted",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const FMC_NAME = /^FMC_[A-Za-z0-9_\-]+$/;

function nameCheck(kind: string, name: unknown, seen: Set<string>, problems: string[]): string {
  if (!str(name)) { problems.push(`${kind}: every item needs a name`); return ""; }
  if (!FMC_NAME.test(name)) problems.push(`${kind} ${name}: the name starts FMC_ and has letters, digits, _ or - only (the kit's naming)`);
  if (seen.has(name.toLowerCase())) problems.push(`${kind} ${name} is in the designs twice`);
  seen.add(name.toLowerCase());
  return name;
}

function checkPattern(p: Record<string, unknown>, seen: Set<string>, problems: string[]) {
  const n = nameCheck("pattern", p.name, seen, problems) || "(no name)";
  if (p.target !== "drafting" && p.target !== "model") problems.push(`pattern ${n}: target is drafting or model`);
  const grids = Array.isArray(p.grids) ? p.grids : [];
  if (grids.length < 1 || grids.length > 6) problems.push(`pattern ${n}: 1 to 6 grids (angle and spacing each)`);
  grids.forEach((g, i) => {
    if (!isObj(g) || !num(g.angle) || g.angle <= -360 || g.angle >= 360) problems.push(`pattern ${n} grid ${i + 1}: angle in degrees (-360 to 360)`);
    if (!isObj(g) || !num(g.spacing) || !(g.spacing > 0)) problems.push(`pattern ${n} grid ${i + 1}: spacing in mm, more than 0`);
    if (isObj(g) && g.shift !== undefined && !num(g.shift)) problems.push(`pattern ${n} grid ${i + 1}: shift is mm`);
    if (isObj(g) && g.origin !== undefined && !(Array.isArray(g.origin) && g.origin.length === 2 && g.origin.every(num)))
      problems.push(`pattern ${n} grid ${i + 1}: origin is [x, y] in mm`);
  });
}

function checkGrid(n: string, which: string, g: unknown, problems: string[]) {
  if (!isObj(g) || !GRID_LAYOUTS.includes(g.layout as GridLayout)) { problems.push(`curtain wall ${n}: ${which}.layout is ${GRID_LAYOUTS.join(", ")}`); return; }
  const needs = g.layout === "fixed_distance" || g.layout === "maximum_spacing" || g.layout === "minimum_spacing";
  if (needs && !(num(g.spacing) && g.spacing > 0)) problems.push(`curtain wall ${n}: ${which}.spacing (mm) is needed for ${g.layout}`);
  if (!needs && g.spacing !== undefined) problems.push(`curtain wall ${n}: ${which}.spacing means nothing with ${g.layout}`);
}

/** The designs checked: problems for a person; the spec typed when there are none. */
export function checkSpec(spec: unknown): { spec: AssembliesSpec | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(spec)) return { spec: null, problems: ["The designs are an object with patterns, curtain_walls and railings"] };
  for (const k of ["patterns", "curtain_walls", "railings"]) if (spec[k] !== undefined && !Array.isArray(spec[k])) problems.push(`${k} is a list`);
  const patterns = (Array.isArray(spec.patterns) ? spec.patterns : []) as unknown[];
  const curtains = (Array.isArray(spec.curtain_walls) ? spec.curtain_walls : []) as unknown[];
  const railings = (Array.isArray(spec.railings) ? spec.railings : []) as unknown[];
  if (!patterns.length && !curtains.length && !railings.length) problems.push("The designs have no patterns, curtain walls or railings");
  const seenP = new Set<string>(), seenT = new Set<string>();
  for (const p of patterns) { if (isObj(p)) checkPattern(p, seenP, problems); else problems.push("pattern: each is an object"); }
  for (const c of curtains) {
    if (!isObj(c)) { problems.push("curtain wall: each is an object"); continue; }
    const n = nameCheck("curtain wall", c.name, seenT, problems) || "(no name)";
    if (!str(c.base)) problems.push(`curtain wall ${n}: base (the model's curtain wall type to start from) is needed`);
    checkGrid(n, "vertical", c.vertical, problems);
    checkGrid(n, "horizontal", c.horizontal, problems);
    if (c.mullion !== undefined && !(isObj(c.mullion) && [c.mullion.interior, c.mullion.border].every((m) => m === undefined || str(m))))
      problems.push(`curtain wall ${n}: mullion is {interior?, border?} type names`);
    if (c.panel !== undefined && !str(c.panel)) problems.push(`curtain wall ${n}: panel is a type name`);
  }
  for (const r of railings) {
    if (!isObj(r)) { problems.push("railing: each is an object"); continue; }
    const n = nameCheck("railing", r.name, seenT, problems) || "(no name)";
    if (!str(r.base)) problems.push(`railing ${n}: base (the model's railing type to start from) is needed`);
    if (!(num(r.height) && r.height > 0)) problems.push(`railing ${n}: height (mm) is needed`);
    if (r.top_rail !== undefined && !str(r.top_rail)) problems.push(`railing ${n}: top_rail is a type name`);
  }
  if (spec.legend !== undefined && !(isObj(spec.legend) && str(spec.legend.view) && (spec.legend.columns === undefined || (Number.isInteger(spec.legend.columns) && (spec.legend.columns as number) > 0))))
    problems.push("legend is {view: name, columns?: whole number}");
  if (problems.length) return { spec: null, problems };
  return { spec: { ...(spec as object), patterns, curtain_walls: curtains, railings } as AssembliesSpec, problems };
}
