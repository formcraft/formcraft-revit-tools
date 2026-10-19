/**
 * The room recipe (docs/PLAN_RECIPE_TREE.md, T1): a room as data, planned into exact elements before anything is built.
 * A room has its size, its walls, its door and window (on a wall, a distance along it), the families placed in it
 * (relative to the room: a wall's centre, a corner, the room's centre, on the ceiling), its ceiling height and its
 * clearances. The planner turns it into the ops the Revit command builds (fmc_room_build), every position in mm in the
 * project's coordinates, and checks it first: doors and windows fit their walls, items stay inside the room, and each
 * item's clearance in front of it is free. Pure.
 */
import { z } from "zod";

const mm = z.number();
export const WALLS = ["north", "east", "south", "west"] as const;
export type WallSide = (typeof WALLS)[number];

export const ROOM = z.object({
  name: z.string().min(1),
  number: z.string().optional(),
  level: z.string().min(1).describe("the level the room is on"),
  origin_mm: z.array(mm).length(2).describe("the room's south-west inner corner, mm"),
  width: mm.positive().describe("east-west, inside the walls, mm"),
  depth: mm.positive().describe("north-south, inside the walls, mm"),
  height: mm.positive().describe("floor to the structure above (wall height), mm"),
  walls: z.object({ type: z.string().min(1), thickness: mm.positive() }),
  ceiling: z.object({ type: z.string().min(1), height: mm.positive() }).optional(),
  openings: z.array(z.object({
    kind: z.enum(["door", "window"]), family: z.string().min(1), type: z.string().min(1), wall: z.enum(WALLS),
    along: mm.describe("from the wall's left end seen from inside, to the opening's centre, mm"), width: mm.positive(),
    sill: mm.optional().describe("window sill height, mm"),
  })).default([]),
  items: z.array(z.object({
    id: z.string().min(1), family: z.string().min(1), type: z.string().min(1),
    at: z.union([
      z.object({ wall: z.enum(WALLS), along: mm.optional().describe("default: the wall's middle"), off: mm.default(0).describe("out from the wall face into the room") }),
      z.object({ centre: z.literal(true), dx: mm.default(0), dy: mm.default(0) }),
      z.object({ x: mm, y: mm }),
    ]),
    z: mm.default(0).describe("height of its base above the floor"),
    host: z.enum(["floor", "wall", "ceiling"]).default("floor"),
    /** Depth in front of it that must stay free (bed: 1200 each side by HBN 04-01, the head-wall panel: 1000), mm. */
    clearance: mm.default(0),
    /** Its footprint, mm (width across the wall or in x, depth into the room), to check it fits. */
    size: z.array(mm).length(2).optional(),
  })).default([]),
});
export type Room = z.infer<typeof ROOM>;

export type Op =
  | { op: "wall"; side: WallSide; start: number[]; end: number[]; height: number; type: string }
  | { op: "opening"; kind: "door" | "window"; family: string; type: string; wall: WallSide; at: number[]; sill: number }
  | { op: "place"; id: string; family: string; type: string; at: number[]; rotate_deg: number; host: "floor" | "wall" | "ceiling"; wall?: WallSide }
  | { op: "ceiling"; outline: number[][]; height: number; type: string }
  | { op: "room"; name: string; number?: string; at: number[] };

/** Each wall's inner face: from its left end to its right end seen from inside the room, and the direction into the room. */
function wallLine(r: Room, side: WallSide): { a: number[]; b: number[]; into: number[]; length: number } {
  const [x0, y0] = r.origin_mm, x1 = x0 + r.width, y1 = y0 + r.depth;
  switch (side) {
    case "south": return { a: [x0, y0], b: [x1, y0], into: [0, 1], length: r.width };
    case "east": return { a: [x1, y0], b: [x1, y1], into: [-1, 0], length: r.depth };
    case "north": return { a: [x1, y1], b: [x0, y1], into: [0, -1], length: r.width };
    case "west": return { a: [x0, y1], b: [x0, y0], into: [1, 0], length: r.depth };
  }
}

const along = (l: { a: number[]; b: number[]; length: number }, d: number) => [l.a[0] + (l.b[0] - l.a[0]) * (d / l.length), l.a[1] + (l.b[1] - l.a[1]) * (d / l.length)];
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface RoomPlan { ops: Op[]; problems: string[]; warnings: string[] }

/** The room into ops, every position resolved; problems stop the build, warnings don't. */
export function planRoom(input: Room): RoomPlan {
  const r = ROOM.parse(input);
  const ops: Op[] = [], problems: string[] = [], warnings: string[] = [];
  const t = r.walls.thickness;
  // the walls on their centre lines, half a thickness outside the inner faces, corners overlapping by a half thickness
  for (const side of WALLS) {
    const l = wallLine(r, side);
    const out = [-l.into[0] * t / 2, -l.into[1] * t / 2];
    const dir = [(l.b[0] - l.a[0]) / l.length, (l.b[1] - l.a[1]) / l.length];
    const a = [l.a[0] + out[0] - dir[0] * t / 2, l.a[1] + out[1] - dir[1] * t / 2], b = [l.b[0] + out[0] + dir[0] * t / 2, l.b[1] + out[1] + dir[1] * t / 2];
    ops.push({ op: "wall", side, start: a.map(r1), end: b.map(r1), height: r.height, type: r.walls.type });
  }
  for (const o of r.openings) {
    const l = wallLine(r, o.wall);
    if (o.along - o.width / 2 < 100 || o.along + o.width / 2 > l.length - 100)
      problems.push(`${o.kind} ${o.type} on the ${o.wall} wall: ${o.width} wide at ${o.along} doesn't fit a ${l.length} mm wall with 100 mm returns`);
    const p = along(l, o.along);
    ops.push({ op: "opening", kind: o.kind, family: o.family, type: o.type, wall: o.wall, at: [r1(p[0]), r1(p[1]), 0], sill: o.kind === "window" ? o.sill ?? 900 : 0 });
  }
  const [x0, y0] = r.origin_mm;
  const centre = [x0 + r.width / 2, y0 + r.depth / 2];
  for (const it of r.items) {
    let p: number[], rot = 0, wall: WallSide | undefined;
    if ("wall" in it.at) {
      const l = wallLine(r, it.at.wall);
      const d = it.at.along ?? l.length / 2;
      const q = along(l, d);
      p = [q[0] + l.into[0] * it.at.off, q[1] + l.into[1] * it.at.off];
      // the family's front faces into the room: rotated so its +y points along the wall's inward direction
      rot = Math.round((Math.atan2(l.into[1], l.into[0]) * 180) / Math.PI - 90);
      wall = it.at.wall;
      if (d < 0 || d > l.length) problems.push(`${it.id}: ${d} mm along the ${it.at.wall} wall is off a ${l.length} mm wall`);
    } else if ("centre" in it.at) p = [centre[0] + it.at.dx, centre[1] + it.at.dy];
    else p = [it.at.x, it.at.y];
    if (p[0] < x0 - 1 || p[0] > x0 + r.width + 1 || p[1] < y0 - 1 || p[1] > y0 + r.depth + 1) problems.push(`${it.id} is outside the room`);
    if (it.host === "ceiling" && !r.ceiling) problems.push(`${it.id} hangs from the ceiling, and the room has none`);
    const z = it.host === "ceiling" && r.ceiling ? r.ceiling.height : it.z;
    ops.push({ op: "place", id: it.id, family: it.family, type: it.type, at: [r1(p[0]), r1(p[1]), z], rotate_deg: rot, host: it.host, ...(wall ? { wall } : {}) });
    // its clearance must stay inside the room (in front of a wall item; around a free-standing one)
    if (it.clearance > 0) {
      if (wall) {
        const room = wall === "north" || wall === "south" ? r.depth : r.width;
        const reach = ("wall" in it.at ? it.at.off : 0) + (it.size?.[1] ?? 0) + it.clearance;
        if (reach > room) problems.push(`${it.id}: its ${it.clearance} mm clearance reaches ${reach} mm into a ${room} mm room`);
      } else {
        const half = (it.size?.[0] ?? 0) / 2 + it.clearance;
        if (p[0] - half < x0 || p[0] + half > x0 + r.width) warnings.push(`${it.id}: its ${it.clearance} mm clearance meets a wall east-west`);
      }
    }
  }
  if (r.ceiling) {
    if (r.ceiling.height >= r.height) problems.push(`The ceiling at ${r.ceiling.height} is at or above the structure (${r.height})`);
    ops.push({ op: "ceiling", outline: [[x0, y0], [x0 + r.width, y0], [x0 + r.width, y0 + r.depth], [x0, y0 + r.depth]], height: r.ceiling.height, type: r.ceiling.type });
  }
  ops.push({ op: "room", name: r.name, ...(r.number ? { number: r.number } : {}), at: [r1(centre[0]), r1(centre[1])] });
  return { ops, problems, warnings };
}
