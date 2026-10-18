/**
 * One family, three levels (docs/PLAN_ENGINEERING_HUB.md; owner's choice, 18 Oct): Coarse is the envelope (LOD 200),
 * Medium the native recipe body (LOD 300), Fine the same body drawn smooth in Rhino (LOD 400).
 *
 * This reads a recipe's native solids (point extrusions, revolutions, sweeps) and writes each one's smooth twin as a
 * Rhino part in the recipe's own coordinates (world millimetres, as the command set draws them), so nothing moves:
 * the arcs the recipe sampled as short segments become true arcs, a 12-point "round" profile becomes a true circle.
 * Then it adds to the recipe what puts the twins in the family: import_part, the same subcategory, material
 * parameter and type switch as the native solid, Fine only; and the native solid becomes Medium only.
 *
 * Pure: no Rhino, no Revit, no files.
 */
import type { RhinoPart } from "./rhino.js";

type Pt = number[];
type Op = Record<string, any>;

/** A recipe's 2D point in a view plane at an offset → world [x, y, z] (FmcDocLod.To3D). */
export function to3d(plane: string, p: Pt, at: number): Pt {
  if (plane === "front") return [p[0], at, p[1]];
  if (plane === "right") return [at, p[0], p[1]];
  return [p[0], p[1], at];
}

/** A Rhino part name from a solid's name: letters, digits and _ (the layer and file name). */
export function partName(solid: string): string {
  const n = solid.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Za-z]/.test(n) ? n : `P_${n}`;
}

/** Solids that stay native at every level: the envelope, clearance zones, connector pads, voids and plane-driven boxes. */
const KEEP_NATIVE = /coarse|clearance|connector|envelope/i;

export interface TwinMap {
  solid: string;          // the native solid
  part: string;           // the Rhino part
  form: string;           // the imported form's name in the family
  subcategory?: string;
  material_param?: string;
  material?: string;      // the kit material behind the parameter (for Rhino's render colour)
  visible_param?: string; // a type switch (e.g. Second Light Head)
}

export interface Twins { parts: RhinoPart[]; map: TwinMap[]; kept: Array<{ solid: string; why: string }> }

/** The smooth twins of a recipe's native solids. */
export function recipeTwins(ops: Op[]): Twins {
  const by = (op: string, key = "name") => {
    const m = new Map<string, Op>();
    for (const o of ops) if (o.op === op && o[key] !== undefined) m.set(String(o[key]), o);
    return m;
  };
  const subcat = by("set_subcategory"), matParam = by("set_material_param"), vis = by("set_visibility"), visParam = by("set_visible_param", "solid");
  const materialOf = new Map<string, string>();
  for (const o of ops) if (o.op === "add_material" && o.param) materialOf.set(o.param, o.name);

  const parts: RhinoPart[] = [], map: TwinMap[] = [], kept: Twins["kept"] = [];
  const used = new Set<string>();
  for (const o of ops) {
    if (!["extrusion", "revolution", "sweep"].includes(o.op)) continue;
    const solid = String(o.name);
    // a subcategory given in its own op, or on the solid op itself (revolution, sweep and blend take one)
    const sc = (subcat.get(solid)?.subcategory ?? o.subcategory) as string | undefined;
    if (KEEP_NATIVE.test(solid) || (sc && KEEP_NATIVE.test(sc))) { kept.push({ solid, why: "stays native (envelope, clearance or connector)" }); continue; }
    const v = vis.get(solid);
    if (v && v.fine === false) { kept.push({ solid, why: "not shown on Fine" }); continue; }
    let spec: Record<string, unknown> | null = null;
    if (o.op === "extrusion") {
      if (o.rect || !Array.isArray(o.points)) { kept.push({ solid, why: "a box between planes stays native (it flexes with its planes)" }); continue; }
      const start = Number(o.start ?? 0), end = Number(o.end ?? 1000), sk = String(o.sketch ?? "plan");
      // FmcDocGeometry.Extrusion: plan draws [x, y] with depth up; front draws [x, z] with depth toward the viewer (-y);
      // right draws [y, z] with depth along +x. The solid runs from start to end along that depth.
      const base = (p: Pt): Pt => (sk === "front" ? [p[0], -start, p[1]] : sk === "right" ? [start, p[0], p[1]] : [p[0], p[1], start]);
      const d = end - start;
      const vector = sk === "front" ? [0, -d, 0] : sk === "right" ? [d, 0, 0] : [0, 0, d];
      spec = { op: "extrude_points", points: (o.points as Pt[]).map(base), vector };
    } else if (o.op === "revolution") {
      if ((o.start_deg ?? 0) !== 0 || (o.end_deg ?? 360) !== 360) { kept.push({ solid, why: "a part revolution stays native" }); continue; }
      const a = (o.axis_at as Pt | undefined) ?? [0, 0], ax = String(o.axis ?? "z");
      // FmcDocLod.MakeRevolution: axis z: origin [x, y, 0], profile [r, z] → origin + (r, 0, z); axis y: origin [x, 0, z],
      // axis -y, profile [r, d] → origin + (r, -d, 0); axis x: origin [0, y, z], axis +x, profile [r, d] → origin + (d, r, 0).
      let origin: Pt, axis: Pt, at: (p: Pt) => Pt;
      if (ax === "y") { origin = [a[0], 0, a[1]]; axis = [0, -1, 0]; at = (p) => [origin[0] + p[0], -p[1], origin[2]]; }
      else if (ax === "x") { origin = [0, a[0], a[1]]; axis = [1, 0, 0]; at = (p) => [p[1], origin[1] + p[0], origin[2]]; }
      else { origin = [a[0], a[1], 0]; axis = [0, 0, 1]; at = (p) => [origin[0] + p[0], origin[1], p[1]]; }
      spec = { op: "revolve_loop", loop: (o.profile as Pt[]).map(at), origin, axis };
    } else {
      if (o.path_planes || !Array.isArray(o.path) || !Array.isArray(o.profile)) { kept.push({ solid, why: "a sweep on planes or a profile family stays native" }); continue; }
      const plane = String(o.path_plane ?? "plan"), at = Number(o.at ?? 0);
      spec = { op: "sweep_path", path: (o.path as Pt[]).map((p) => to3d(plane, p, at)), profile: o.profile };
    }
    let part = partName(solid);
    while (used.has(part)) part += "_2";
    used.add(part);
    const mp = matParam.get(solid)?.param as string | undefined;
    const material = mp ? materialOf.get(mp) : undefined;
    parts.push({ name: part, ...spec, subcategory: sc ?? "", material: material ?? mp ?? "", visibility: "fine" } as RhinoPart);
    map.push({ solid, part, form: `${solid} Fine`, subcategory: sc, material_param: mp, material, visible_param: visParam.get(solid)?.param });
  }
  return { parts, map, kept };
}

/**
 * The recipe with its twins: each exported twin imported, on its native solid's subcategory and material parameter,
 * Fine only, with the same type switch; each native solid's own visibility becomes Medium only (edited in place, so
 * no op repeats). A twin Rhino didn't export (it failed its check) is left out, and its native solid stays on Fine.
 */
export function withTwins(ops: Op[], map: TwinMap[], exported: Map<string, { file: string; size_mm?: number[] }>): { ops: Op[]; twins: number } {
  const done = map.filter((t) => exported.has(t.part));
  const native = new Set(done.map((t) => t.solid));
  const out: Op[] = ops.map((o) => (o.op === "set_visibility" && native.has(o.name) ? { ...o, coarse: false, medium: true, fine: false } : o));
  const hasVis = new Set(ops.filter((o) => o.op === "set_visibility").map((o) => o.name));
  for (const t of done) {
    const e = exported.get(t.part)!;
    if (!hasVis.has(t.solid)) out.push({ op: "set_visibility", name: t.solid, coarse: false, medium: true, fine: false });
    out.push({ op: "import_part", name: t.form, file: e.file, ...(e.size_mm ? { size_mm: e.size_mm } : {}) });
    if (t.subcategory) out.push({ op: "set_subcategory", name: t.form, subcategory: t.subcategory });
    if (t.material_param) out.push({ op: "set_material_param", name: t.form, param: t.material_param });
    out.push({ op: "set_visibility", name: t.form, coarse: false, medium: false, fine: true });
    if (t.visible_param) out.push({ op: "set_visible_param", name: `${t.form}/Visible`, solid: t.form, param: t.visible_param });
  }
  return { ops: out, twins: done.length };
}
