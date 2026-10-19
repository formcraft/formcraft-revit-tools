/**
 * Departments (docs/PLAN_RECIPE_TREE.md, T4): many rooms along a corridor, laid out before anything is modelled.
 * A department has a corridor running east-west and a row of rooms on its north side, its south side, or both. The
 * layout gives every room its origin and says which of its walls it builds: a wall between two rooms is built once (by
 * the room to its west), and a room's corridor wall is the room's (the corridor builds only its end walls), so no wall is
 * ever doubled. Each room becomes a tree node copied from a template room, with its own inputs (size, origin, the walls
 * it skips, which wall faces the corridor), so changing one room rebuilds only that room. Pure.
 */
import { z } from "zod";
import type { TreeNode } from "./tree.js";
import type { WallSide } from "./room.js";

const mm = z.number();

const ROW_ROOM = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "a room id is letters, digits, _ -"),
  name: z.string().optional(),
  number: z.string().optional(),
  width: mm.positive().describe("along the corridor, inside the walls, mm"),
  depth: mm.positive().describe("away from the corridor, inside the walls, mm"),
  template: z.string().optional().describe("a room node to copy (default: the department's template)"),
});

export const DEPARTMENT = z.object({
  origin_mm: z.array(mm).length(2).describe("the corridor's south-west inner corner, mm"),
  wall_thickness: mm.positive(),
  corridor: z.object({ width: mm.positive().describe("north-south, inside the walls, mm"), length: mm.positive().optional().describe("default: the longer row"),
    name: z.string().default("Corridor"), number: z.string().optional() }),
  north: z.array(ROW_ROOM).default([]),
  south: z.array(ROW_ROOM).default([]),
});
export type Department = z.infer<typeof DEPARTMENT>;

export interface LaidRoom {
  id: string; name: string; number?: string; side: "north" | "south" | "corridor";
  origin: number[]; width: number; depth: number; skip: WallSide[];
  /** The wall that faces the corridor, and the one opposite (a bed's head wall). */
  corridor_wall?: WallSide; head_wall?: WallSide; template?: string;
}

export interface DepartmentLayout { rooms: LaidRoom[]; corridor: LaidRoom; problems: string[]; warnings: string[] }

const r1 = (v: number) => Math.round(v * 10) / 10;

export function layoutDepartment(input: Department): DepartmentLayout {
  const d = DEPARTMENT.parse(input);
  const t = d.wall_thickness, [cx, cy] = d.origin_mm, W = d.corridor.width;
  const problems: string[] = [], warnings: string[] = [], rooms: LaidRoom[] = [];
  const rowLength = (row: Department["north"]) => row.reduce((s, r) => s + r.width, 0) + Math.max(0, row.length - 1) * t;
  const L = d.corridor.length ?? Math.max(rowLength(d.north), rowLength(d.south));
  if (!L) problems.push("The department has no rooms and no corridor length");
  const ids = new Set<string>();
  for (const side of ["north", "south"] as const) {
    let x = cx;
    d[side].forEach((r, i) => {
      if (ids.has(r.id)) problems.push(`The room id ${r.id} is used twice`);
      ids.add(r.id);
      const y = side === "north" ? cy + W + t : cy - t - r.depth;
      const corridor_wall: WallSide = side === "north" ? "south" : "north";
      // the room to the west builds the shared wall: this room skips its west wall when it has a western neighbour
      rooms.push({ id: r.id, name: r.name ?? r.id, ...(r.number ? { number: r.number } : {}), side, origin: [r1(x), r1(y)], width: r.width, depth: r.depth,
        skip: i > 0 ? ["west"] : [], corridor_wall, head_wall: side === "north" ? "north" : "south", ...(r.template ? { template: r.template } : {}) });
      x += r.width + t;
    });
    const len = rowLength(d[side]);
    if (d[side].length && len > L + 0.5) problems.push(`The ${side} row is ${len} mm long, the corridor ${L} mm`);
    if (d[side].length && len < L - 0.5) warnings.push(`The ${side} row stops ${r1(L - len)} mm short of the corridor's east end: that stretch of the corridor's ${side} side has no wall`);
  }
  // the corridor builds its end walls; its long sides are the rooms' walls where a row runs, its own where none does
  const skip: WallSide[] = [];
  if (d.north.length) skip.push("north");
  if (d.south.length) skip.push("south");
  const corridor: LaidRoom = { id: "Corridor", name: d.corridor.name, ...(d.corridor.number ? { number: d.corridor.number } : {}), side: "corridor",
    origin: [r1(cx), r1(cy)], width: L, depth: W, skip };
  return { rooms, corridor, problems, warnings };
}

/** A room's own inputs in the tree (what changes when the layout moves or resizes it). */
export function roomInputs(r: LaidRoom): Record<string, unknown> {
  return { width: r.width, depth: r.depth, origin: r.origin, number: r.number ?? r.id, skip_walls: r.skip,
    ...(r.corridor_wall ? { corridor_wall: r.corridor_wall, head_wall: r.head_wall } : {}) };
}

/**
 * A template room's children copied for a new room: its ids renamed (template id → the new room's id), the families it
 * loads left out (they're loaded once, by the template), and its room build told to skip the walls a neighbour builds.
 */
export function cloneChildren(template: TreeNode, newId: string): TreeNode[] {
  const rename = (id: string) => id.startsWith(template.id) ? newId + id.slice(template.id.length) : `${newId}.${id}`;
  const copy = (n: TreeNode): TreeNode => {
    const c: TreeNode = JSON.parse(JSON.stringify(n));
    c.id = rename(n.id);
    delete c.overrides;
    if (c.make?.tool === "fmc_room") {
      const room = (c.make.args.room ?? {}) as Record<string, any>;
      room.walls = { ...(room.walls ?? {}), skip: "${var.skip_walls}" };
      c.make.args.room = room;
      delete c.make.args.keep; // a person's overrides belong to the room they were made in
    }
    c.children = (n.children ?? []).filter(keepKid).map(copy);
    if (!c.children.length) delete c.children;
    return c;
  };
  const keepKid = (n: TreeNode) => n.kind !== "family" && !(n.kind === "group" && (n.children ?? []).every((k) => k.kind === "family"));
  return (template.children ?? []).filter(keepKid).map(copy);
}

/** The corridor's node: an fmc_room with no openings or items, its walls as the layout says. */
export function corridorNode(deptId: string, c: LaidRoom): TreeNode {
  return {
    id: `${deptId}.Corridor`, kind: "room", name: c.name, inputs: roomInputs(c),
    make: { tool: "fmc_room", args: { action: "build", room: {
      name: c.name, ...(c.number ? { number: c.number } : {}), level: "${var.level}", origin_mm: "${var.origin}",
      width: "${var.width}", depth: "${var.depth}", height: "${var.structure_height}",
      walls: { type: "${var.wall_type}", thickness: "${var.wall_thickness}", skip: "${var.skip_walls}" },
      ceiling: { type: "${var.ceiling_type}", height: "${var.ceiling_height}" }, openings: [], items: [],
    } } },
  };
}

export interface LayoutChange { add: string[]; update: string[]; remove: string[]; same: string[] }

/**
 * The department's children after a layout: generated rooms (id <dept>.<room>) are added, updated (their inputs only, so
 * a person's adopted edits and overrides in them stay) or removed; children a person added by hand are kept as they are.
 * refresh: re-copy existing rooms from their template too (their adopted edits are lost: the dry run says so).
 */
export function applyLayout(dept: TreeNode, layout: DepartmentLayout, templates: (id: string) => TreeNode | null, defaultTemplate: string, refresh = false): { children: TreeNode[]; change: LayoutChange; problems: string[] } {
  const prefix = `${dept.id}.`;
  const old = new Map((dept.children ?? []).filter((c) => c.id.startsWith(prefix) && c.inputs?._layout).map((c) => [c.id, c]));
  const kept = (dept.children ?? []).filter((c) => !(c.id.startsWith(prefix) && c.inputs?._layout));
  const change: LayoutChange = { add: [], update: [], remove: [], same: [] };
  const problems: string[] = [];
  const made: TreeNode[] = [];
  for (const r of [layout.corridor, ...layout.rooms]) {
    const id = prefix + r.id;
    const inputs = { _layout: true, ...roomInputs(r) };
    const was = old.get(id);
    old.delete(id);
    if (r.side === "corridor") {
      const n = corridorNode(dept.id, r);
      n.inputs = inputs;
      if (was) { n.make = was.make; n.overrides = was.overrides; }
      (JSON.stringify(was?.inputs) === JSON.stringify(inputs) ? change.same : was ? change.update : change.add).push(id);
      made.push(n);
      continue;
    }
    if (was && !refresh) {
      (JSON.stringify(was.inputs) === JSON.stringify(inputs) ? change.same : change.update).push(id);
      made.push({ ...was, name: r.name, inputs });
      continue;
    }
    const tid = r.template ?? defaultTemplate;
    const t = templates(tid);
    if (!t) { problems.push(`${r.id}: no template room ${tid}`); continue; }
    (was ? change.update : change.add).push(id);
    made.push({ id, kind: "room", name: r.name, inputs, children: cloneChildren(t, id) });
  }
  change.remove.push(...old.keys());
  return { children: [...kept, ...made], change, problems };
}
