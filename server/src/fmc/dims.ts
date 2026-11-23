/**
 * Dimension strings along parallel grids and along exterior walls, with openings in the chain.
 * A dry run returns the references and the dimension line. It does not create a dimension.
 * Coordinates are millimetres in the plan.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DIMS_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_dims needs document, a title or a full path. The active document is not a guess.",
  "FMC-DIMS-VIEW": "fmc_dims needs view, a plan view name or id.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-DIMS-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-DIMS-TARGETS": "targets is grids, walls, openings, interior, rooms, or a list of those.",
  "FMC-DIMS-NEED-PAIR": "A dimension string needs two references.",
  "FMC-DIMS-NO-REFERENCE": "Revit did not return a stable reference for that element.",
  "FMC-DIMS-NOT-EXTERIOR": "Interior walls are not dimensioned unless targets includes interior.",
};

export type DimTarget = "grids" | "walls" | "openings" | "interior" | "rooms";

export interface DimCurve {
  id: string;
  name?: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  function?: string;
}

export interface DimOpening {
  id: string;
  host_id?: string;
  x: number;
  y: number;
  width_mm?: number;
}

export interface DimRef {
  id: string;
  role: "grid" | "wall_start" | "wall_end" | "opening" | "wall_side" | "room_side";
  name?: string;
  nx?: number;
  ny?: number;
}

export interface DimRoomBound {
  wall_id: string;
  side: "left" | "right" | "bottom" | "top";
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export interface DimRoom {
  id: string;
  name?: string;
  x: number;
  y: number;
  bounds: DimRoomBound[];
}

export interface DimStringPlan {
  kind: DimTarget | "interior" | "rooms";
  chain: boolean;
  offset_mm: number;
  references: DimRef[];
  line: { x0: number; y0: number; x1: number; y1: number };
}

export interface DimSkip {
  id?: string;
  code: string;
  reason: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function hypot(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

interface Axis {
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  ang: number;
}

function axisOf(curve: DimCurve): Axis | null {
  const dx = curve.x1 - curve.x0;
  const dy = curve.y1 - curve.y0;
  const len = hypot(dx, dy);
  if (len < 1) return null;
  let ux = dx / len;
  let uy = dy / len;
  if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uy < 0)) { ux = -ux; uy = -uy; }
  let nx = -uy;
  let ny = ux;
  if (nx < -1e-9 || (Math.abs(nx) <= 1e-9 && ny < 0)) { nx = -nx; ny = -ny; }
  let ang = Math.atan2(uy, ux) * 180 / Math.PI;
  if (ang < 0) ang += 180;
  if (ang >= 180) ang -= 180;
  return { ux, uy, nx, ny, ang };
}

function dot(x: number, y: number, ax: number, ay: number): number {
  return x * ax + y * ay;
}

function groupKey(ang: number): number {
  return Math.round(ang);
}

interface Group<T extends DimCurve> {
  axis: Axis;
  items: T[];
}

function groupParallel<T extends DimCurve>(items: T[]): Group<T>[] {
  const groups: Group<T>[] = [];
  for (const item of items) {
    const axis = axisOf(item);
    if (!axis) continue;
    const key = groupKey(axis.ang);
    let group = groups.find((row) => Math.abs(groupKey(row.axis.ang) - key) <= 1 || Math.abs(groupKey(row.axis.ang) - key) >= 179);
    if (!group) {
      group = { axis, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function lineFor(axis: Axis, station: number, s0: number, s1: number): DimStringPlan["line"] {
  const a = { x: axis.ux * station + axis.nx * s0, y: axis.uy * station + axis.ny * s0 };
  const b = { x: axis.ux * station + axis.nx * s1, y: axis.uy * station + axis.ny * s1 };
  return { x0: r1(a.x), y0: r1(a.y), x1: r1(b.x), y1: r1(b.y) };
}

function stationOf(curves: DimCurve[], axis: Axis, offset: number): number {
  let max = -Infinity;
  for (const curve of curves) {
    max = Math.max(max, dot(curve.x0, curve.y0, axis.ux, axis.uy), dot(curve.x1, curve.y1, axis.ux, axis.uy));
  }
  return max + offset;
}

function sortByNormal<T extends DimCurve>(items: T[], axis: Axis): T[] {
  return [...items].sort((a, b) => {
    const sa = dot((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, axis.nx, axis.ny);
    const sb = dot((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, axis.nx, axis.ny);
    return sa - sb;
  });
}

function gridStrings(grids: DimCurve[], chain: boolean, offset: number): { strings: DimStringPlan[]; skipped: DimSkip[] } {
  const strings: DimStringPlan[] = [];
  const skipped: DimSkip[] = [];
  for (const group of groupParallel(grids)) {
    const ordered = sortByNormal(group.items, group.axis);
    if (ordered.length < 2) {
      skipped.push({ id: ordered[0]?.id, code: "FMC-DIMS-NEED-PAIR", reason: DIMS_FIX["FMC-DIMS-NEED-PAIR"] });
      continue;
    }
    const batches = chain ? [ordered] : ordered.slice(0, -1).map((item, i) => [item, ordered[i + 1]]);
    for (const batch of batches) {
      const s = batch.map((item) => dot((item.x0 + item.x1) / 2, (item.y0 + item.y1) / 2, group.axis.nx, group.axis.ny));
      strings.push({
        kind: "grids",
        chain,
        offset_mm: offset,
        references: batch.map((item) => ({ id: item.id, role: "grid" as const, name: item.name })),
        line: lineFor(group.axis, stationOf(batch, group.axis, offset), Math.min(...s), Math.max(...s)),
      });
    }
  }
  return { strings, skipped };
}

export function isExterior(fn: string | undefined): boolean {
  const text = (fn ?? "").trim().toLowerCase();
  return text === "exterior" || text === "1" || text === "wallfunction.exterior";
}

export function isInterior(fn: string | undefined): boolean {
  const text = (fn ?? "").trim().toLowerCase();
  return text === "interior" || text === "0" || text === "wallfunction.interior";
}

function along(curve: DimCurve, axis: Axis, x: number, y: number): number {
  return dot(x, y, axis.ux, axis.uy);
}

/** A dimension parallel to the wall, offset to the left of the wall direction. */
function wallLine(wall: DimCurve, axis: Axis, offset: number): DimStringPlan["line"] {
  const a0 = dot(wall.x0, wall.y0, axis.ux, axis.uy);
  const a1 = dot(wall.x1, wall.y1, axis.ux, axis.uy);
  const side = dot((wall.x0 + wall.x1) / 2, (wall.y0 + wall.y1) / 2, axis.nx, axis.ny) + offset;
  const at = (alongPos: number) => ({
    x: axis.ux * alongPos + axis.nx * side,
    y: axis.uy * alongPos + axis.ny * side,
  });
  const a = at(Math.min(a0, a1));
  const b = at(Math.max(a0, a1));
  return { x0: r1(a.x), y0: r1(a.y), x1: r1(b.x), y1: r1(b.y) };
}

function wallStrings(walls: DimCurve[], openings: DimOpening[], targets: Set<DimTarget>, chain: boolean, offset: number): { strings: DimStringPlan[]; skipped: DimSkip[] } {
  const strings: DimStringPlan[] = [];
  const skipped: DimSkip[] = [];
  const exterior: DimCurve[] = [];
  const wantsInterior = targets.has("interior");
  for (const wall of walls) {
    if (!isExterior(wall.function)) {
      if (!wantsInterior || !isInterior(wall.function)) {
        skipped.push({ id: wall.id, code: "FMC-DIMS-NOT-EXTERIOR", reason: DIMS_FIX["FMC-DIMS-NOT-EXTERIOR"] });
      }
      continue;
    }
    exterior.push(wall);
  }
  const wantWall = targets.has("walls");
  const wantOpen = targets.has("openings");
  for (const group of groupParallel(exterior)) {
    for (const wall of sortByNormal(group.items, group.axis)) {
      const axis = axisOf(wall) ?? group.axis;
      const hostOpen = openings.filter((item) => (item.host_id ?? "") === wall.id)
        .sort((a, b) => along(wall, axis, a.x, a.y) - along(wall, axis, b.x, b.y));
      const refs: DimRef[] = [];
      if (wantWall) refs.push({ id: wall.id, role: "wall_start", name: wall.name });
      if (wantOpen) for (const opening of hostOpen) refs.push({ id: opening.id, role: "opening" });
      if (wantWall) refs.push({ id: wall.id, role: "wall_end", name: wall.name });
      const openingOnly = wantOpen && !wantWall;
      if (openingOnly && hostOpen.length < 1) {
        skipped.push({ id: wall.id, code: "FMC-DIMS-NEED-PAIR", reason: DIMS_FIX["FMC-DIMS-NEED-PAIR"] });
        continue;
      }
      if (!openingOnly && refs.length < 2) {
        skipped.push({ id: wall.id, code: "FMC-DIMS-NEED-PAIR", reason: DIMS_FIX["FMC-DIMS-NEED-PAIR"] });
        continue;
      }
      const batches = chain || refs.length < 2 ? [refs] : refs.slice(0, -1).map((item, i) => [item, refs[i + 1]]);
      const line = wallLine(wall, axis, offset);
      for (const batch of batches) {
        strings.push({
          kind: openingOnly ? "openings" : "walls",
          chain,
          offset_mm: offset,
          references: batch,
          line,
        });
      }
    }
  }
  return { strings, skipped };
}

/** Parallel interior partitions, one chain across the run, the same way grids are chained. */
function interiorStrings(walls: DimCurve[], chain: boolean, offset: number): { strings: DimStringPlan[]; skipped: DimSkip[] } {
  const strings: DimStringPlan[] = [];
  const skipped: DimSkip[] = [];
  const interior = walls.filter((wall) => isInterior(wall.function));
  for (const group of groupParallel(interior)) {
    const ordered = sortByNormal(group.items, group.axis);
    if (ordered.length < 2) {
      skipped.push({ id: ordered[0]?.id, code: "FMC-DIMS-NEED-PAIR", reason: DIMS_FIX["FMC-DIMS-NEED-PAIR"] });
      continue;
    }
    const batches = chain ? [ordered] : ordered.slice(0, -1).map((item, i) => [item, ordered[i + 1]]);
    for (const batch of batches) {
      const s = batch.map((item) => dot((item.x0 + item.x1) / 2, (item.y0 + item.y1) / 2, group.axis.nx, group.axis.ny));
      strings.push({
        kind: "interior",
        chain,
        offset_mm: offset,
        references: batch.map((item) => ({ id: item.id, role: "wall_side" as const, name: item.name, nx: r1(group.axis.nx), ny: r1(group.axis.ny) })),
        line: lineFor(group.axis, stationOf(batch, group.axis, offset), Math.min(...s), Math.max(...s)),
      });
    }
  }
  return { strings, skipped };
}

function sideOf(bounds: DimRoomBound[], side: DimRoomBound["side"]): DimRoomBound | undefined {
  return bounds.find((row) => row.side === side);
}

/** Two clear dimensions per room, between the bounding wall faces. */
function roomStrings(rooms: DimRoom[], offset: number): { strings: DimStringPlan[]; skipped: DimSkip[] } {
  const strings: DimStringPlan[] = [];
  const skipped: DimSkip[] = [];
  for (const room of rooms) {
    if (!(room.bounds ?? []).length) {
      skipped.push({ id: room.id, code: "FMC-DIMS-NEED-PAIR", reason: DIMS_FIX["FMC-DIMS-NEED-PAIR"] });
      continue;
    }
    const pairs: Array<[DimRoomBound["side"], DimRoomBound["side"], "x" | "y"]> = [["left", "right", "y"], ["bottom", "top", "x"]];
    for (const [a, b, across] of pairs) {
      const first = sideOf(room.bounds ?? [], a);
      const second = sideOf(room.bounds ?? [], b);
      if (!first || !second) {
        skipped.push({ id: room.id, code: "FMC-DIMS-NEED-PAIR", reason: DIMS_FIX["FMC-DIMS-NEED-PAIR"] });
        continue;
      }
      const line = across === "y"
        ? { x0: r1(first.x), y0: r1(room.y), x1: r1(second.x), y1: r1(room.y) }
        : { x0: r1(room.x), y0: r1(first.y), x1: r1(room.x), y1: r1(second.y) };
      strings.push({
        kind: "rooms",
        chain: false,
        offset_mm: offset,
        references: [first, second].map((bound) => ({ id: bound.wall_id, role: "room_side" as const, name: room.name, nx: bound.nx, ny: bound.ny })),
        line,
      });
    }
  }
  return { strings, skipped };
}

export function planDims(input: {
  grids?: DimCurve[];
  walls?: DimCurve[];
  openings?: DimOpening[];
  rooms?: DimRoom[];
  targets: DimTarget[];
  chain: boolean;
  offset_mm: number;
}): { strings: DimStringPlan[]; skipped: DimSkip[] } {
  const targets = new Set(input.targets);
  const strings: DimStringPlan[] = [];
  const skipped: DimSkip[] = [];
  if (targets.has("grids")) {
    const grids = gridStrings(input.grids ?? [], input.chain, input.offset_mm);
    strings.push(...grids.strings);
    skipped.push(...grids.skipped);
  }
  if (targets.has("walls") || targets.has("openings")) {
    const planned = wallStrings(input.walls ?? [], input.openings ?? [], targets, input.chain, input.offset_mm);
    strings.push(...planned.strings);
    skipped.push(...planned.skipped);
  }
  if (targets.has("interior")) {
    const planned = interiorStrings(input.walls ?? [], input.chain, input.offset_mm);
    strings.push(...planned.strings);
    skipped.push(...planned.skipped);
  }
  if (targets.has("rooms")) {
    const planned = roomStrings(input.rooms ?? [], input.offset_mm);
    strings.push(...planned.strings);
    skipped.push(...planned.skipped);
  }
  return { strings, skipped };
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return DIMS_FIX["FMC-DIMS-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return DIMS_FIX["FMC-DIMS-REFERENCES"];
  }
  return null;
}

export function dimsDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_DIMS_DIR ?? "").trim()) return env.FMC_DIMS_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "dims");
}

export function writeDimsReport(env: NodeJS.ProcessEnv, body: unknown, dir = dimsDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `dims-auto-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
