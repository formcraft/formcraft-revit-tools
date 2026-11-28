/**
 * Legend layout and the parameter order for a copied legend component.
 * Revit has no LegendComponent.Create and no View.Create for a legend. fmc_legend copies a seed.
 * View-direction integers are the ones the kit measured (KISIC lesson 8): there is no public enum.
 * Free text notes are never part of this plan.
 */

/** Paper millimetres in a legend view become API feet times the view scale. */
export function paperMmToFeet(mm: number, scale: number): number {
  return (mm * scale) / 304.8;
}

export interface GridSlot {
  index: number;
  col: number;
  row: number;
  x_mm: number;
  y_mm: number;
}

/** Row-major grid. Y decreases down the view, the same direction the kit legends use. */
export function gridSlot(
  index: number,
  columns: number,
  spacingXmm: number,
  spacingYmm: number,
  originXmm = 0,
  originYmm = 0,
): GridSlot {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const col = index % cols;
  const row = Math.floor(index / cols);
  return {
    index,
    col,
    row,
    x_mm: originXmm + col * spacingXmm,
    y_mm: originYmm - row * spacingYmm,
  };
}

/**
 * Integers stored in LEGEND_COMPONENT_VIEW. From the kit, not from a public enum:
 * −4 ceiling plan, −8 floor plan, −7/−6/−9/−10 elevations front/back/right/left, −3 3D, −5 section.
 */
export const LEGEND_VIEW = {
  elevation_front: -7,
  elevation_back: -6,
  elevation_right: -9,
  elevation_left: -10,
  ceiling_plan: -4,
  floor_plan: -8,
  section: -5,
  three_d: -3,
} as const;

export type LegendDirectionName = keyof typeof LEGEND_VIEW;

const HOSTS = new Set(["door", "doors", "window", "windows", "wall", "walls", "floor", "floors", "roof", "roofs", "ceiling", "ceilings"]);

export function legendCategory(category: string): string {
  const c = category.trim().toLowerCase().replace(/\s+/g, "");
  if (c === "doors") return "door";
  if (c === "windows") return "window";
  if (c === "walls") return "wall";
  if (c === "floors") return "floor";
  if (c === "roofs") return "roof";
  if (c === "ceilings") return "ceiling";
  return c;
}

export function knownLegendCategory(category: string): boolean {
  return HOSTS.has(category.trim().toLowerCase().replace(/\s+/g, ""));
}

/** Doors and windows face front. Walls, floors and roofs are a section. Ceilings use the ceiling plan. */
export function directionFor(category: string): { name: LegendDirectionName; value: number } | null {
  const c = legendCategory(category);
  if (c === "door" || c === "window") return { name: "elevation_front", value: LEGEND_VIEW.elevation_front };
  if (c === "wall" || c === "floor" || c === "roof") return { name: "section", value: LEGEND_VIEW.section };
  if (c === "ceiling") return { name: "ceiling_plan", value: LEGEND_VIEW.ceiling_plan };
  return null;
}

/**
 * Set order. The type has to be assigned before the view direction, and the length only after that.
 * Length is for walls. A section of a floor keeps the seed length unless the caller is a wall.
 */
export function paramOrder(category: string): string[] {
  if (!directionFor(category)) return [];
  const order = ["LEGEND_COMPONENT", "LEGEND_COMPONENT_VIEW"];
  if (legendCategory(category) === "wall") order.push("LEGEND_COMPONENT_LENGTH");
  return order;
}

export type LabelMode = "none" | "keynote" | "type_mark";

export interface LabelPlan {
  mode: LabelMode;
  attempt: "none" | "keynote_tag" | "type_mark_tag";
  free_text: false;
  /** A failed tag still returns type marks so a schedule can name the row. */
  needs_type_marks: boolean;
}

export function labelPlan(mode: LabelMode): LabelPlan {
  if (mode === "none") return { mode, attempt: "none", free_text: false, needs_type_marks: false };
  if (mode === "keynote") return { mode, attempt: "keynote_tag", free_text: false, needs_type_marks: true };
  return { mode, attempt: "type_mark_tag", free_text: false, needs_type_marks: true };
}

export interface PlaceItemPlan {
  index: number;
  type_id: string;
  category: string;
  x_mm: number;
  y_mm: number;
  direction_name: string;
  direction: number;
  params: string[];
  length_mm: number | null;
}

export function placePlan(input: {
  types: Array<{ id: string | number; category: string }>;
  columns: number;
  spacing_x_mm: number;
  spacing_y_mm: number;
  origin_x_mm: number;
  origin_y_mm: number;
  length_mm: number;
}): { items: PlaceItemPlan[]; rejected: Array<{ id: string; category: string; code: string; fix: string }> } {
  const items: PlaceItemPlan[] = [];
  const rejected: Array<{ id: string; category: string; code: string; fix: string }> = [];
  for (const type of input.types) {
    const id = String(type.id);
    const direction = directionFor(type.category);
    const params = paramOrder(type.category);
    if (!direction || !params.length) {
      rejected.push({
        id,
        category: type.category,
        code: "FMC-LEGEND-CATEGORY",
        fix: "category must be door, window, wall, floor, roof or ceiling.",
      });
      continue;
    }
    const slot = gridSlot(items.length, input.columns, input.spacing_x_mm, input.spacing_y_mm, input.origin_x_mm, input.origin_y_mm);
    const wall = legendCategory(type.category) === "wall";
    items.push({
      index: slot.index,
      type_id: id,
      category: legendCategory(type.category),
      x_mm: slot.x_mm,
      y_mm: slot.y_mm,
      direction_name: direction.name,
      direction: direction.value,
      params,
      length_mm: wall ? input.length_mm : null,
    });
  }
  return { items, rejected };
}

export const LEGEND_FIX: Record<string, string> = {
  "FMC-LEGEND-NO-SEED": "place one legend component by hand once",
  "FMC-LEGEND-NO-VIEW": "Duplicate needs a legend view that already exists. Revit will not create a ViewLegend. Make one legend view by hand, then run create_view.",
  "FMC-LEGEND-COPY-REFUSED": "Revit refused the copy. The API cannot create a legend view or a legend component, and this call does not pretend the copy worked.",
  "FMC-LEGEND-NAME-TAKEN": "A view already has that name. Pick another name. This tool does not delete the existing view.",
  "FMC-LEGEND-CATEGORY": "category must be door, window, wall, floor, roof or ceiling.",
  "FMC-LEGEND-PARAM-REJECTED": "Parameter.Set returned false. The component was not kept. Check the type can show that view direction.",
  "FMC-LEGEND-LABEL-UNSUPPORTED": "A legend view did not accept the tag. No text note was placed. The type marks are in this reply for a companion schedule.",
  "FMC-LEGEND-REFERENCES": "A write needs references.kit, references.standards and references.rulebook, each with one id.",
  "FMC-LEGEND-GUARD": "This file is protected, a central, or HEBERT HOSTELS. Nothing was written.",
  "FMC-BATCH-LOCKED": "Request a lease with fmc_batch. Pass batch_lease, and references.kit, references.standards and references.rulebook.",
  "FMC-DOC-REQUIRED": "Pass document, a title or a full path. The active document is not used.",
};
