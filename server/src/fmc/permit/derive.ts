/**
 * Building figures derived from the model facts: ground level, storeys, height, gross floor area, footprint,
 * area per level and basement depth. Measurement only; no regulation value is used here.
 */
import type { PermitFacts } from "./facts.js";

export interface Derived {
  ground: { name: string; elevation_mm: number } | null;
  ground_source: "argument" | "elevation 0" | "lowest level" | "none";
  storeys: number;
  occupied_levels: string[];
  height_m: number | null;
  height_source: "roofs" | "levels" | "none";
  top_floor_height_m: number | null;
  gfa_m2: number;
  gfa_source: "floors" | "rooms" | "none";
  footprint_m2: number;
  level_area_m2: Record<string, number>;
  basement_depth_m: number | null;
  notes: string[];
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function derive(f: PermitFacts, groundLevel?: string, toleranceMm = 10): Derived {
  const notes: string[] = [];
  const levels = [...f.levels].sort((a, b) => a.elevation_mm - b.elevation_mm);
  let ground: Derived["ground"] = null;
  let ground_source: Derived["ground_source"] = "none";
  if (groundLevel && groundLevel.trim()) {
    const g = levels.find((l) => l.name.toLowerCase() === groundLevel.trim().toLowerCase());
    if (g) { ground = g; ground_source = "argument"; } else notes.push(`ground_level "${groundLevel}" is not a level in the model; using the model's own ground.`);
  }
  if (!ground) {
    const zero = levels.filter((l) => Math.abs(l.elevation_mm) <= toleranceMm).sort((a, b) => Math.abs(a.elevation_mm) - Math.abs(b.elevation_mm))[0];
    if (zero) { ground = zero; ground_source = "elevation 0"; } else if (levels.length) { ground = levels[0]; ground_source = "lowest level"; notes.push(`No level at elevation 0; the lowest level "${levels[0].name}" is taken as ground.`); }
  }
  const g = ground?.elevation_mm ?? 0;

  const level_area_m2: Record<string, number> = {};
  for (const fl of f.floors) level_area_m2[fl.level] = round((level_area_m2[fl.level] ?? 0) + fl.area_m2);
  let gfa_source: Derived["gfa_source"] = "floors";
  if (!f.floors.length) {
    gfa_source = f.rooms.length ? "rooms" : "none";
    for (const r of f.rooms) level_area_m2[r.level] = round((level_area_m2[r.level] ?? 0) + r.area_m2);
    notes.push(gfa_source === "rooms" ? "No floors in the model: floor area is the sum of room areas (smaller than gross floor area)." : "No floors or rooms in the model: floor area is unknown.");
  }
  const gfa_m2 = round(Object.values(level_area_m2).reduce((a, b) => a + b, 0));

  const occupied = new Set<string>([...f.floors.map((x) => x.level), ...f.rooms.map((x) => x.level)]);
  const occ = levels.filter((l) => occupied.has(l.name));
  const above = occ.filter((l) => l.elevation_mm >= g - toleranceMm);
  const below = occ.filter((l) => l.elevation_mm < g - toleranceMm);
  const top = above.length ? above[above.length - 1] : null;
  const top_floor_height_m = top ? round((top.elevation_mm - g) / 1000, 3) : null;

  const roofTops = f.roofs.map((r) => r.top_mm).filter((x): x is number => x !== null);
  let height_m: number | null = null;
  let height_source: Derived["height_source"] = "none";
  if (roofTops.length) { height_m = round((Math.max(...roofTops) - g) / 1000, 3); height_source = "roofs"; }
  else if (levels.length) {
    height_m = round((levels[levels.length - 1].elevation_mm - g) / 1000, 3); height_source = "levels";
    notes.push("No roofs in the model: height is the highest level above ground, which understates the building height.");
  }

  const footprint_m2 = ground ? round(f.floors.filter((x) => x.level === ground!.name).reduce((a, b) => a + b.area_m2, 0)) : 0;
  const basement_depth_m = below.length ? round((g - below[0].elevation_mm) / 1000, 3) : null;

  return { ground, ground_source, storeys: above.length, occupied_levels: occ.map((l) => l.name), height_m, height_source, top_floor_height_m, gfa_m2, gfa_source, footprint_m2, level_area_m2, basement_depth_m, notes };
}
