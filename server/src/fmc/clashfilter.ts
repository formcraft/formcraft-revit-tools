/**
 * Clash false-positive rules and the legacy bbox import.
 * Live Revit geometry is internal feet and is stored in millimetres (× 304.8).
 * plugin_readonly/export_bboxes.cs and export_openings.cs are not in this repo.
 * import: reads the documented millimetre schema and is not scaled again.
 */

export const MM_PER_FOOT = 304.8;

export const DEFAULT_CLASH_CATEGORIES = [
  "OST_Walls", "OST_Floors", "OST_Ceilings", "OST_Roofs",
  "OST_Columns", "OST_StructuralColumns", "OST_StructuralFraming", "OST_StructuralFoundation",
  "OST_Doors", "OST_Windows",
  "OST_PipeCurves", "OST_PipeFitting", "OST_PipeAccessory", "OST_FlexPipeCurves",
  "OST_DuctCurves", "OST_DuctFitting", "OST_DuctAccessory", "OST_FlexDuctCurves", "OST_DuctTerminal",
  "OST_Conduit", "OST_ConduitFitting", "OST_CableTray", "OST_CableTrayFitting",
  "OST_MechanicalEquipment", "OST_PlumbingFixtures", "OST_PlumbingEquipment",
  "OST_ElectricalFixtures", "OST_ElectricalEquipment", "OST_LightingFixtures", "OST_LightingDevices",
  "OST_Site", "OST_GenericModel", "OST_SpecialityEquipment",
] as const;

const HOST_CATEGORIES = ["OST_Walls", "OST_Floors", "OST_Ceilings", "OST_Roofs", "OST_StructuralColumns", "OST_StructuralFraming", "OST_StructuralFoundation", "OST_Site"];
const GUEST_CATEGORIES = [
  "OST_PipeCurves", "OST_DuctCurves", "OST_Conduit", "OST_CableTray",
  "OST_PipeFitting", "OST_DuctFitting", "OST_MechanicalEquipment",
  "OST_PlumbingEquipment", "OST_PlumbingFixtures", "OST_GenericModel", "OST_SpecialityEquipment",
  "OST_ElectricalFixtures", "OST_LightingFixtures",
];

export function defaultClashPairs(): Array<{ a: string; b: string }> {
  const pairs: Array<{ a: string; b: string }> = [];
  for (const a of HOST_CATEGORIES) for (const b of GUEST_CATEGORIES) pairs.push({ a, b });
  return pairs;
}

export type HitStatus = "hard" | "cleared_by_opening" | "join" | "hosted" | "clearance";

export interface Box3 {
  min: number[];
  max: number[];
}

export interface OpeningRef extends Box3 {
  id: number;
  host_id?: number;
}

export interface HitFacts {
  a: number;
  b: number;
  category_a: string;
  category_b: string;
  box_a: Box3;
  box_b: Box3;
  host_of_a?: number;
  host_of_b?: number;
  joined?: boolean;
  centreline_miss?: boolean;
}

const WALLISH = /OST_Walls|OST_Floors|OST_Ceilings|OST_Roofs/i;

function axisOverlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

export function overlapDepth(a: Box3, b: Box3): number {
  const depths = [0, 1, 2].map((axis) => axisOverlap(a.min[axis] ?? 0, a.max[axis] ?? 0, b.min[axis] ?? 0, b.max[axis] ?? 0));
  if (depths.some((depth) => depth < 0)) return 0;
  return Math.min(...depths);
}

function intersection(a: Box3, b: Box3): Box3 | null {
  const min = [0, 1, 2].map((axis) => Math.max(a.min[axis] ?? 0, b.min[axis] ?? 0));
  const max = [0, 1, 2].map((axis) => Math.min(a.max[axis] ?? 0, b.max[axis] ?? 0));
  if (min.some((value, axis) => value > max[axis])) return null;
  return { min, max };
}

function contains(outer: Box3, inner: Box3, pad = 1): boolean {
  return [0, 1, 2].every((axis) => (inner.min[axis] ?? 0) >= (outer.min[axis] ?? 0) - pad && (inner.max[axis] ?? 0) <= (outer.max[axis] ?? 0) + pad);
}

export function classifyHit(hit: HitFacts, openings: OpeningRef[] = [], clearanceMm = 0): { status: HitStatus; opening_id?: number } {
  if (hit.joined) return { status: "join" };
  if ((hit.host_of_a && hit.host_of_a === hit.b) || (hit.host_of_b && hit.host_of_b === hit.a)) return { status: "hosted" };
  const wallId = WALLISH.test(hit.category_a) ? hit.a : WALLISH.test(hit.category_b) ? hit.b : 0;
  const overlap = intersection(hit.box_a, hit.box_b);
  if (wallId && overlap) {
    const opening = openings.find((item) => (item.host_id == null || item.host_id === wallId) && contains(item, overlap));
    if (opening) return { status: "cleared_by_opening", opening_id: opening.id };
  }
  if (hit.centreline_miss) return { status: "clearance" };
  const depth = overlapDepth(hit.box_a, hit.box_b);
  if (clearanceMm > 0 && depth > 0 && depth <= clearanceMm) return { status: "clearance" };
  return { status: "hard" };
}

/** Expand the box by radius and test the centreline segment. Coordinates are millimetres. */
export function centrelineHitsBox(p0: number[], p1: number[], box: Box3, radiusMm: number): boolean {
  const min = box.min.map((value) => value - radiusMm);
  const max = box.max.map((value) => value + radiusMm);
  const dir = [0, 1, 2].map((axis) => (p1[axis] ?? 0) - (p0[axis] ?? 0));
  let t0 = 0;
  let t1 = 1;
  for (let axis = 0; axis < 3; axis++) {
    const start = p0[axis] ?? 0;
    const delta = dir[axis];
    if (Math.abs(delta) < 1e-9) {
      if (start < min[axis] || start > max[axis]) return false;
      continue;
    }
    let near = (min[axis] - start) / delta;
    let far = (max[axis] - start) / delta;
    if (near > far) { const swap = near; near = far; far = swap; }
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

export interface SleeveRef extends OpeningRef {
  name?: string;
  kind: "opening" | "sleeve";
}

export function sleevesNear(items: SleeveRef[], where: { point?: number[]; radius_mm?: number; a?: number; b?: number; box?: Box3 }): SleeveRef[] {
  const radius = where.radius_mm ?? 500;
  const point = where.point;
  return items.filter((item) => {
    if (where.a && (item.id === where.a || item.host_id === where.a || item.id === where.b || item.host_id === where.b)) return true;
    if (where.box && overlapDepth(item, where.box) > 0) return true;
    if (!point) return false;
    const centre = [0, 1, 2].map((axis) => ((item.min[axis] ?? 0) + (item.max[axis] ?? 0)) / 2);
    const gap = Math.hypot(centre[0] - (point[0] ?? 0), centre[1] - (point[1] ?? 0), centre[2] - (point[2] ?? 0));
    return gap <= radius;
  });
}

export interface LegacyExport {
  doc?: string;
  captured_at?: string;
  elements?: Array<{ id?: number; category?: string; bbox_mm?: { min?: number[]; max?: number[] }; unique_id?: string }>;
  openings?: Array<{ id?: number; host_id?: number; bbox_mm?: { min?: number[]; max?: number[] } }>;
}

export function importLegacy(raw: LegacyExport, writtenAt = new Date().toISOString()): { header: { kind: "fmc_clash_cache"; doc_title: string; path: string; saved_at: string; written_at: string; categories: string[]; mesh_cap: number }; elements: Array<{ id: number; unique_id: string; category: string; min: number[]; max: number[]; host_id?: number }> } {
  const elements = [];
  for (const row of raw.elements ?? []) {
    const min = row.bbox_mm?.min ?? [];
    const max = row.bbox_mm?.max ?? [];
    if (min.length < 3 || max.length < 3 || !row.id) continue;
    elements.push({ id: row.id, unique_id: row.unique_id || String(row.id), category: row.category || "OST_GenericModel", min, max });
  }
  for (const row of raw.openings ?? []) {
    const min = row.bbox_mm?.min ?? [];
    const max = row.bbox_mm?.max ?? [];
    if (min.length < 3 || max.length < 3 || !row.id) continue;
    elements.push({ id: row.id, unique_id: String(row.id), category: "opening", min, max, ...(row.host_id ? { host_id: row.host_id } : {}) });
  }
  const categories = [...new Set(elements.map((element) => element.category))];
  return {
    header: {
      kind: "fmc_clash_cache",
      doc_title: raw.doc || "import",
      path: "",
      saved_at: raw.captured_at || writtenAt,
      written_at: writtenAt,
      categories,
      mesh_cap: 0,
    },
    elements,
  };
}
