/**
 * Load takedown, preliminary (owner 27 Oct: "insert loads and everything", structural design of the Ogala house).
 * From fmc_struct_facts (the architecture model's walls, floors, roofs and rooms) and the kit's standards (Uganda
 * Structural Design Code 2019; unit weights from EN 1991-1-1 Annex A), in kN, kN/m and kN/m²:
 *
 * - every suspended slab: self-weight (its structure layers), its own other layers, the finish floors laid on it,
 *   services and ceilings, partitions (non-bearing walls standing on it, as an equivalent spread load) and the imposed
 *   load from the rooms on it (by use: floors, balconies and terraces, stairs, storage);
 * - every wall: its self-weight per metre (layers x height, less openings);
 * - every roof: covering, battens, rafters and ceiling on plan, and the imposed load for roofs;
 * - per level and in all: G and Q, and the combinations 1.35G + 1.5Q (ULS), G + Q (characteristic) and G + ψ2·Q.
 *
 * For comparing structural options only: each slab's load goes to the walls standing under it in proportion to their
 * length (no spans, no continuity). Robot's analysis replaces this. Everything here is PRELIMINARY until the engineer
 * of record signs.
 */

export type Pt = [number, number, number?];
export interface Layer { function: string; thickness_mm: number; material: string; density_kg_m3?: number | null }
export interface FactWall { id: number; type: string; function?: string; thickness_mm: number; length_mm: number; height_mm: number; base_level: string; top_level?: string; start_mm: Pt; end_mm: Pt; openings_area_m2?: number; layers: Layer[] }
export interface FactFloor { id: number; type: string; level: string; area_m2: number; thickness_mm: number; layers: Layer[]; outline_mm?: Pt[][] | null }
export interface FactRoof { id: number; type: string; level: string; area_m2: number; plan_min_mm?: Pt | null; plan_max_mm?: Pt | null; layers: Layer[] }
export interface FactRoom { id: number; number: string; name: string; level: string; area_m2: number; at_mm?: Pt | null }
export interface Facts { from?: string; levels: Array<{ name: string; elevation_mm: number }>; walls: FactWall[]; floors: FactFloor[]; roofs: FactRoof[]; rooms: FactRoom[] }

/** The standards the takedown reads (fmc_standards' resolved values for the project's use). */
export type Std = (key: string) => any;

const r2 = (x: number) => Math.round(x * 100) / 100;

/** kN/m³ for a material: its own density when the model has one, else the kit's table by name; null when unknown. */
export function unitWeight(layer: Pick<Layer, "material" | "density_kg_m3">, std: Std): number | null {
  if (layer.density_kg_m3 && layer.density_kg_m3 > 0) return r2(layer.density_kg_m3 * 9.81 / 1000);
  const name = (layer.material ?? "").toLowerCase();
  for (const [rx, w] of (std("loads.unit_weights") ?? []) as Array<[string, number]>) if (new RegExp(rx).test(name)) return w;
  return null;
}

/** kN/m² of a set of layers, with the materials nobody could weigh. */
export function layersLoad(layers: Layer[], std: Std, only?: (l: Layer) => boolean): { kn_m2: number; unknown: string[] } {
  let kn = 0; const unknown: string[] = [];
  for (const l of layers) {
    if (only && !only(l)) continue;
    const w = unitWeight(l, std);
    if (w === null) { if (l.thickness_mm > 0) unknown.push(l.material); continue; }
    kn += w * l.thickness_mm / 1000;
  }
  return { kn_m2: r2(kn), unknown };
}

const isStructure = (l: Layer) => /structure/i.test(l.function);

/** A suspended structural slab: a concrete structure layer, not bearing on hardcore or the ground. */
export function slabKind(f: FactFloor): "suspended" | "on_ground" | "finish" | "ground_finish" {
  const concrete = f.layers.some((l) => isStructure(l) && /concrete|rc\b/i.test(l.material)) || /\brc\b|slab/i.test(f.type);
  const ground = f.layers.some((l) => /hardcore|sand bed|soil|geotextile|murram/i.test(l.material)) || /hardcore|sand bed|topsoil|geotextile|pebble|stepping/i.test(f.type);
  if (concrete) return ground ? "on_ground" : "suspended";
  return ground ? "ground_finish" : "finish";
}

/** Imposed load (kN/m²) for a room, by its name: balconies and terraces, stairs, storage, else the floor of the use. */
export function imposedFor(roomName: string, std: Std): { q: number; as: string } {
  const n = roomName.toLowerCase();
  if (/balcon|terrace|deck|veranda|verandah|patio/.test(n)) return { q: std("loads.imposed_balconies") ?? 2.5, as: "balcony/terrace" };
  if (/\bstair/.test(n)) return { q: std("loads.imposed_stairs") ?? 2.0, as: "stairs" };
  if (/attic|storage|store room/.test(n)) return { q: 2.5, as: "storage (attic, as typed)" };
  return { q: std("loads.imposed_floor") ?? 1.5, as: "floor" };
}

/** Point in polygon (plan), the first loop the outline, later loops holes. */
export function inside(p: Pt, outline: Pt[][] | null | undefined): boolean {
  if (!outline?.length) return false;
  const inLoop = (loop: Pt[]) => {
    let c = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = loop[i], [xj, yj] = loop[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return inLoop(outline[0]) && !outline.slice(1).some(inLoop);
}

/** Wall self-weight in kN/m along its length (all layers, height less the openings). */
export function wallLoad(w: FactWall, std: Std): { kn_m: number; kn_m2: number; unknown: string[] } {
  const { kn_m2, unknown } = layersLoad(w.layers, std);
  const solid = Math.max(0, (w.length_mm / 1000) * (w.height_mm / 1000) - (w.openings_area_m2 ?? 0));
  return { kn_m: w.length_mm > 0 ? r2(kn_m2 * solid / (w.length_mm / 1000)) : 0, kn_m2, unknown };
}

const mid = (w: FactWall): Pt => [(w.start_mm[0] + w.end_mm[0]) / 2, (w.start_mm[1] + w.end_mm[1]) / 2];

export interface TakedownOptions {
  /** walls that carry slabs (option A: bearing masonry); default every stone, brick or block wall 100 mm thick or more */
  bearing?: (w: FactWall) => boolean;
  /** ψ2 for the quasi-permanent combination (residential 0.3) */
  psi2?: number;
}

export function defaultBearing(w: FactWall): boolean {
  return w.thickness_mm >= 100 && w.layers.some((l) => isStructure(l) && /stone|block|brick|concrete/i.test(l.material)) && !/curtain|glazing/i.test(w.type);
}

export function takedown(f: Facts, std: Std, opts: TakedownOptions = {}) {
  const bearing = opts.bearing ?? defaultBearing;
  const psi2 = opts.psi2 ?? 0.3;
  const unknown = new Set<string>();
  const warnings: string[] = [];
  const services = std("loads.services_and_ceilings") ?? 0.5;

  // exterior slabs (terraces, paving, decks) at or near the ground bear on it: not part of the structure
  const elevOf = (lvl: string) => f.levels.find((l) => l.name === lvl)?.elevation_mm ?? 0;
  const groundExt = (x: FactFloor) => /\bext\b/i.test(x.type) && elevOf(x.level) <= 500;
  const slabs = f.floors.filter((x) => slabKind(x) === "suspended" && !groundExt(x));
  const onGround = f.floors.filter((x) => slabKind(x) === "on_ground" || slabKind(x) === "suspended" && groundExt(x));
  const finishes = f.floors.filter((x) => slabKind(x) === "finish");
  const centre = (fl: FactFloor): Pt | null => {
    const loop = fl.outline_mm?.[0]; if (!loop?.length) return null;
    return [loop.reduce((a, p) => a + p[0], 0) / loop.length, loop.reduce((a, p) => a + p[1], 0) / loop.length];
  };

  const wallRows = f.walls.map((w) => {
    const wl = wallLoad(w, std); wl.unknown.forEach((u) => unknown.add(u));
    return { id: w.id, type: w.type, level: w.base_level, top_level: w.top_level ?? "", length_m: r2(w.length_mm / 1000), height_m: r2(w.height_mm / 1000), thickness_mm: w.thickness_mm,
      self_kn_m: wl.kn_m, bearing: bearing(w), from_slabs_g_kn: 0, from_slabs_q_kn: 0 };
  });

  const slabRows = slabs.map((s) => {
    const self = layersLoad(s.layers, std, isStructure), other = layersLoad(s.layers, std, (l) => !isStructure(l));
    [...self.unknown, ...other.unknown].forEach((u) => unknown.add(u));
    // finish floors on this slab (same level, centre inside the outline)
    let finishKn = 0;
    for (const fin of finishes.filter((x) => x.level === s.level)) {
      const c = centre(fin);
      if (c && inside(c, s.outline_mm)) { const l = layersLoad(fin.layers, std); l.unknown.forEach((u) => unknown.add(u)); finishKn += l.kn_m2 * fin.area_m2; }
    }
    // rooms on this slab
    const rooms = f.rooms.filter((r) => r.level === s.level && r.at_mm && inside(r.at_mm, s.outline_mm));
    const roomArea = rooms.reduce((a, r) => a + r.area_m2, 0);
    const qKn = rooms.reduce((a, r) => a + imposedFor(r.name, std).q * r.area_m2, 0);
    // a load written in the type's name ("storage 2.5 kN/m2") wins; exterior slabs without rooms are terraces
    const typed = /([\d.]+)\s*kn\/m/i.exec(s.type);
    const ext = /\bext\b|deck|terrace|balcon/i.test(s.type);
    let q = roomArea > 0 ? qKn / roomArea : ext ? imposedFor("terrace", std).q : std("loads.imposed_floor") ?? 1.5;
    if (typed) q = Math.max(q, Number(typed[1]));
    if (!rooms.length && !ext && !typed) warnings.push(`slab ${s.id} (${s.type}, ${s.level}) has no rooms on it: imposed ${q} kN/m² assumed`);
    // non-bearing walls standing on it: an equivalent spread load
    const partKn = f.walls.filter((w) => w.base_level === s.level && !bearing(w) && inside(mid(w), s.outline_mm))
      .reduce((a, w) => a + wallLoad(w, std).kn_m * w.length_mm / 1000, 0);
    const area = s.area_m2 || 1;
    const g = r2(self.kn_m2 + other.kn_m2 + finishKn / area + services + partKn / area);
    return { id: s.id, type: s.type, level: s.level, area_m2: s.area_m2,
      g_self: self.kn_m2, g_layers: other.kn_m2, g_finishes: r2(finishKn / area), g_services: services, g_partitions: r2(partKn / area), g, q: r2(q),
      rooms: rooms.map((r) => `${r.number} ${r.name}: ${imposedFor(r.name, std).q} (${imposedFor(r.name, std).as})`),
      total_g_kn: r2(g * s.area_m2), total_q_kn: r2(q * s.area_m2), uls_kn_m2: r2(1.35 * g + 1.5 * q) };
  });

  // roofs: covering by type, rafters, ceiling; imposed for roofs
  const ru = std("loads.roof_build_up") ?? {};
  const roofRows = f.roofs.map((r) => {
    const tiles = /clay tile/i.test(r.type) ? ru.clay_tiles_and_battens ?? 0.65 : /concrete tile/i.test(r.type) ? ru.concrete_tiles_and_battens ?? 0.55 : /sheet|seam|metal|iron/i.test(r.type) ? ru.metal_sheet ?? 0.1 : null;
    const covering = tiles ?? layersLoad(r.layers, std).kn_m2;
    const g = r2(covering + (ru.rafters_and_purlins_timber ?? 0.15) + (ru.ceiling_and_insulation ?? 0.2));
    const q = std("loads.imposed_roof_inaccessible") ?? 0.4;
    return { id: r.id, type: r.type, level: r.level, area_m2: r.area_m2, g, q, total_g_kn: r2(g * r.area_m2), total_q_kn: r2(q * r.area_m2) };
  });

  // slab loads to the bearing walls under them, by length (preliminary)
  for (const s of slabs) {
    const row = slabRows.find((x) => x.id === s.id)!;
    const elev = f.levels.find((l) => l.name === s.level)?.elevation_mm ?? 0;
    const under = wallRows.filter((w) => w.bearing && f.walls.find((x) => x.id === w.id)!.top_level === s.level ||
      w.bearing && (() => { const fw = f.walls.find((x) => x.id === w.id)!; const base = f.levels.find((l) => l.name === fw.base_level)?.elevation_mm ?? 0; return base < elev && base + fw.height_mm >= elev - 300; })())
      .filter((w) => { const fw = f.walls.find((x) => x.id === w.id)!; return inside(mid(fw), s.outline_mm) || nearEdge(mid(fw), s.outline_mm, fw.thickness_mm + 50); });
    const len = under.reduce((a, w) => a + w.length_m, 0);
    if (!len) { warnings.push(`slab ${s.id} (${s.level}) has no bearing wall under it: it needs beams or columns`); continue; }
    for (const w of under) { w.from_slabs_g_kn = r2(w.from_slabs_g_kn + row.total_g_kn * w.length_m / len); w.from_slabs_q_kn = r2(w.from_slabs_q_kn + row.total_q_kn * w.length_m / len); }
  }

  const levels = f.levels.map((l) => {
    const sl = slabRows.filter((s) => s.level === l.name), rf = roofRows.filter((r) => r.level === l.name);
    const walls = wallRows.filter((w) => w.level === l.name);
    const G = sl.reduce((a, s) => a + s.total_g_kn, 0) + rf.reduce((a, r) => a + r.total_g_kn, 0) + walls.reduce((a, w) => a + w.self_kn_m * w.length_m, 0);
    const Q = sl.reduce((a, s) => a + s.total_q_kn, 0) + rf.reduce((a, r) => a + r.total_q_kn, 0);
    return { level: l.name, elevation_mm: l.elevation_mm, g_kn: r2(G), q_kn: r2(Q) };
  }).filter((l) => l.g_kn || l.q_kn);
  const G = levels.reduce((a, l) => a + l.g_kn, 0), Q = levels.reduce((a, l) => a + l.q_kn, 0);

  for (const u of unknown) warnings.push(`no unit weight for "${u}": add it to loads.unit_weights or give the material a density`);
  return {
    status: "PRELIMINARY – NOT FOR CONSTRUCTION (no engineer of record)",
    method: "slab loads shared to the bearing walls under them by length; no spans or continuity: for comparing options, Robot's analysis replaces it",
    units: "kN, kN/m, kN/m²",
    totals: { g_kn: r2(G), q_kn: r2(Q), uls_kn: r2(1.35 * G + 1.5 * Q), characteristic_kn: r2(G + Q), quasi_permanent_kn: r2(G + psi2 * Q) },
    levels, slabs: slabRows, roofs: roofRows,
    on_ground: onGround.map((x) => ({ id: x.id, type: x.type, level: x.level, area_m2: x.area_m2 })),
    walls: wallRows.map((w) => ({ ...w, base_line_g_kn_m: w.bearing && w.length_m ? r2(w.self_kn_m + w.from_slabs_g_kn / w.length_m) : w.self_kn_m,
      base_line_q_kn_m: w.bearing && w.length_m ? r2(w.from_slabs_q_kn / w.length_m) : 0 })),
    warnings,
  };
}

/** A point within d mm of an outline's edge (walls under a slab's edge). */
function nearEdge(p: Pt, outline: Pt[][] | null | undefined, d: number): boolean {
  for (const loop of outline ?? []) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
    if (Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= d) return true;
  }
  return false;
}
