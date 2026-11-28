/** Casework engine: the workshop standards (design inputs, nothing defaulted). Part of casework.ts. */

// ---------------------------------------------------------------------------------------------------------------
// Workshop standards (design inputs; the kit has no casework standards file yet, so they come from the call)

export interface Standards {
  sheet: { length: number; width: number };
  kerf: number;
  carcass_board: string;
  carcass_thickness: number;
  front_board: string;
  back_board: string;
  /** Kit material for the edge band; optional (without it the edge banding is "price needed") */
  edge_band?: string;
  /** Kit material for the worktop; optional */
  worktop?: string;
  worktop_depth: number;
  base: { height: number; depth: number };
  wall: { height: number; depth: number };
  tall: { height: number; depth: number };
  plinth: number;
  /** How far a corner unit's return runs along the next wall (the worktop depth in an L) */
  corner_return: number;
  construction: {
    front_gap: number;
    back_clearance: number;
    top_rail: number;
    top_rails: number;
    sink_top_rails: number;
    shelf_setback: number;
    shelf_clearance: number;
    blind_panel: number;
    corner_door: number;
    drawer: {
      side_length: number;
      side_drop: number;
      back_allowance: number;
      bottom_allowance: number;
      bottom_depth: number;
      /** Drawer front heights before the front gap, by number of drawers: {"2": [287, 430], "3": [140, 287, 287]} */
      heights: Record<string, number[]>;
    };
  };
  shelves: { base: number; wall: number; tall: number };
  hardware: {
    hinges_per_door: number;
    hinges_per_tall_door: number;
    legs: number;
    legs_wide: number;
    legs_wide_from: number;
    shelf_pins_per_shelf: number;
    hangers_per_wall_unit: number;
    runner_length: number;
  };
}

/** Every field a complete set of standards needs, as dotted paths. */
export const STANDARD_FIELDS: string[] = [
  "sheet.length", "sheet.width", "kerf", "carcass_board", "carcass_thickness", "front_board", "back_board", "worktop_depth",
  "base.height", "base.depth", "wall.height", "wall.depth", "tall.height", "tall.depth", "plinth", "corner_return",
  "construction.front_gap", "construction.back_clearance", "construction.top_rail", "construction.top_rails",
  "construction.sink_top_rails", "construction.shelf_setback", "construction.shelf_clearance", "construction.blind_panel",
  "construction.corner_door", "construction.drawer.side_length", "construction.drawer.side_drop",
  "construction.drawer.back_allowance", "construction.drawer.bottom_allowance", "construction.drawer.bottom_depth",
  "construction.drawer.heights", "shelves.base", "shelves.wall", "shelves.tall", "hardware.hinges_per_door",
  "hardware.hinges_per_tall_door", "hardware.legs", "hardware.legs_wide", "hardware.legs_wide_from",
  "hardware.shelf_pins_per_shelf", "hardware.hangers_per_wall_unit", "hardware.runner_length",
];

export const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);

export function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Kit standards first, the call's values over them (a project's own choice wins); nested objects merge. */
export function mergeStandards(kit: unknown, given: unknown): Record<string, unknown> {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isObj(a)) return b === undefined ? a : b;
    if (!isObj(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  };
  return (merge(isObj(kit) ? kit : {}, isObj(given) ? given : {}) ?? {}) as Record<string, unknown>;
}

/** Missing or non-positive fields; nothing is filled in. */
export function checkStandards(s: unknown): { standards: Standards | null; missing: string[]; problems: string[] } {
  const missing: string[] = [];
  const problems: string[] = [];
  for (const f of STANDARD_FIELDS) {
    const v = get(s, f);
    if (v === undefined || v === null || v === "") { missing.push(f); continue; }
    if (f.endsWith("_board")) { if (typeof v !== "string") problems.push(`${f} is a kit material name`); continue; }
    if (f === "construction.drawer.heights") {
      if (!isObj(v) || Object.values(v).some((h) => !Array.isArray(h) || h.some((x) => typeof x !== "number" || !(x > 0))))
        problems.push(`${f} is {"<number of drawers>": [heights in mm]}`);
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) problems.push(`${f} must be a number ≥ 0 (mm or a count)`);
  }
  for (const f of ["sheet.length", "sheet.width", "carcass_thickness", "base.height", "base.depth", "wall.height", "wall.depth", "tall.height", "tall.depth"])
    if (get(s, f) === 0) problems.push(`${f} can't be 0`);
  if (missing.length || problems.length) return { standards: null, missing, problems };
  return { standards: s as unknown as Standards, missing, problems };
}
