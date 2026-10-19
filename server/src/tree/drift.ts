/**
 * Hand edits back into the tree (docs/PLAN_RECIPE_TREE.md, T3). Every element a room build makes has a key (which op of
 * the recipe made it) and a snapshot of its facts. The next look compares the model with the snapshots and lists what a
 * person changed by hand: moved, retyped, a parameter changed, deleted. Each edit is then the person's choice:
 *   adopt    the recipe takes the change (a moved bed's position, a swapped door type), so every rebuild keeps it;
 *   override the element is the person's from now on: rebuilds leave it as it is (its key goes in the room's keep list).
 * Nothing is ever silently undone. Moves are adopted as deltas, so a room sized by ${var.width} stays sized by it.
 */
import type { Op, Room, WallSide } from "./room.js";

/** What Revit says about an element now (fmc_element_facts): the parts the snapshot keeps. */
export interface LiveFacts {
  unique_id?: string;
  type_name?: string;
  point_mm?: number[];
  start_mm?: number[];
  end_mm?: number[];
  params?: Record<string, number | string | null>;
}

export interface Snapshot {
  key: string;
  unique_id: string;
  type_name?: string;
  point_mm?: number[];
  start_mm?: number[];
  end_mm?: number[];
  params?: Record<string, number | string | null>;
}

export type EditKind = "deleted" | "moved" | "retyped" | "param";

export interface Edit {
  key: string;
  unique_id: string;
  kind: EditKind;
  /** For a move: how far, mm (model x, y, z). */
  delta_mm?: number[];
  param?: string;
  was?: number | string | null;
  now?: number | string | null;
  sentence: string;
  /** Whether the recipe can take it (adopt); an override is always possible. */
  adoptable: boolean;
}

/** The parameters a person is likely to change by hand that the recipe also sets. */
export const WATCH = ["Sill Height", "Head Height", "Unconnected Height", "Base Offset", "Top Offset", "Height Offset From Level", "Elevation from Level", "Offset from Host"];

/** Each op's key, in the order of the ops: stable across rebuilds while the recipe names the same thing. */
export function opKeys(ops: Op[]): string[] {
  const seen = new Map<string, number>();
  return ops.map((o) => {
    let k: string;
    switch (o.op) {
      case "wall": k = `wall:${o.side}`; break;
      case "opening": k = `${o.kind}@${o.wall}:${o.family}:${o.type}`; break;
      case "place": k = `item:${o.id}`; break;
      case "ceiling": k = "ceiling"; break;
      case "room": k = "room"; break;
    }
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}

export function snapshot(key: string, f: LiveFacts & { unique_id: string }): Snapshot {
  const params: Record<string, number | string | null> = {};
  for (const p of WATCH) if (f.params && p in f.params) params[p] = f.params[p];
  return { key, unique_id: f.unique_id, ...(f.type_name ? { type_name: f.type_name } : {}),
    ...(f.point_mm ? { point_mm: f.point_mm } : {}), ...(f.start_mm ? { start_mm: f.start_mm } : {}), ...(f.end_mm ? { end_mm: f.end_mm } : {}),
    ...(Object.keys(params).length ? { params } : {}) };
}

const TOL = 1; // mm: Revit's own rounding is well under this
const sub = (a: number[], b: number[]) => a.map((v, i) => Math.round((v - (b[i] ?? 0)) * 10) / 10);
const far = (d: number[]) => d.some((v) => Math.abs(v) > TOL);
const kindOf = (key: string) => key.split(/[:@#]/)[0];

/** Which edits the recipe can take, by what made the element. */
function canAdopt(key: string, kind: EditKind, param?: string): boolean {
  const k = kindOf(key);
  if (k === "item") return kind === "moved" || kind === "retyped" || kind === "deleted";
  if (k === "door" || k === "window") return kind === "moved" || kind === "retyped" || kind === "deleted" || (k === "window" && param === "Sill Height");
  if (k === "ceiling") return kind === "retyped" || (kind === "param" && param === "Height Offset From Level");
  // a wall's or the room's own change reshapes the room: kept as an override, or the room's inputs are changed instead
  return false;
}

/** What a person changed by hand since the snapshots (keys in keep are theirs already, and skipped). */
export function findEdits(snaps: Snapshot[], live: Map<string, LiveFacts | null>, keep: Set<string> = new Set()): Edit[] {
  const out: Edit[] = [];
  for (const s of snaps) {
    if (keep.has(s.key)) continue;
    const f = live.get(s.unique_id);
    const add = (e: Omit<Edit, "key" | "unique_id" | "adoptable">) => out.push({ key: s.key, unique_id: s.unique_id, ...e, adoptable: canAdopt(s.key, e.kind, e.param) });
    if (!f) { add({ kind: "deleted", sentence: `${s.key} was deleted` }); continue; }
    if (s.type_name && f.type_name && s.type_name !== f.type_name)
      add({ kind: "retyped", was: s.type_name, now: f.type_name, sentence: `${s.key} changed type: ${s.type_name} → ${f.type_name}` });
    const moved = s.point_mm && f.point_mm ? sub(f.point_mm, s.point_mm)
      : s.start_mm && f.start_mm ? sub(f.start_mm, s.start_mm) : null;
    const endMoved = s.end_mm && f.end_mm ? sub(f.end_mm, s.end_mm) : null;
    if ((moved && far(moved)) || (endMoved && far(endMoved)))
      add({ kind: "moved", delta_mm: moved ?? endMoved!, sentence: `${s.key} moved ${(moved ?? endMoved!).map((v) => Math.round(v)).join(", ")} mm` });
    for (const [p, was] of Object.entries(s.params ?? {})) {
      const now = f.params?.[p];
      if (now === undefined) continue;
      const differ = typeof was === "number" && typeof now === "number" ? Math.abs(was - now) > TOL : was !== now;
      if (differ) add({ kind: "param", param: p, was, now, sentence: `${s.key}: ${p} ${was} → ${now}` });
    }
  }
  return out;
}

/** Along each wall (seen from inside, left to right) and into the room. */
const FRAME: Record<WallSide, { dir: number[]; into: number[] }> = {
  south: { dir: [1, 0], into: [0, 1] }, east: { dir: [0, 1], into: [-1, 0] },
  north: { dir: [-1, 0], into: [0, -1] }, west: { dir: [0, -1], into: [1, 0] },
};
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1];
const r1 = (v: number) => Math.round(v * 10) / 10;
const num = (v: unknown, what: string): number => {
  if (typeof v === "number") return v;
  throw new Error(`${what} is ${JSON.stringify(v)} here (an inherited input): change it in the tree's inputs, or keep the element as an override`);
};

/**
 * The recipe takes a hand edit: `room` is the node's own room arguments (changed in place; ${var} values stay as they
 * are unless the edit is about that very value), `sized` the same room with its inputs filled in (for a wall's length).
 * Returns what changed, in a sentence; throws when the recipe can't take it (keep it as an override then).
 */
export function adoptEdit(room: Record<string, any>, sized: Room, e: Edit): string {
  if (!e.adoptable) throw new Error(`${e.key}: a ${e.kind} here reshapes the room; keep it as an override, or change the room's inputs`);
  const k = kindOf(e.key);
  if (k === "item") {
    const id = e.key.slice("item:".length).replace(/#\d+$/, "");
    const items: any[] = room.items ?? [];
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`The recipe has no item ${id} any more`);
    if (e.kind === "deleted") { items.splice(i, 1); return `${id} taken out of the recipe`; }
    if (e.kind === "retyped") { items[i].type = e.now; return `${id} is now ${e.now}`; }
    const d = e.delta_mm!, at = items[i].at;
    if ("wall" in at) {
      const f = FRAME[at.wall as WallSide];
      const length = at.wall === "north" || at.wall === "south" ? sized.width : sized.depth;
      const along0 = at.along === undefined ? length / 2 : num(at.along, `${id}'s along`);
      at.along = r1(along0 + dot(d, f.dir));
      at.off = r1(num(at.off ?? 0, `${id}'s off`) + dot(d, f.into));
      return `${id}: ${at.along} along the ${at.wall} wall, ${at.off} off it`;
    }
    if ("centre" in at) { at.dx = r1(num(at.dx ?? 0, `${id}'s dx`) + d[0]); at.dy = r1(num(at.dy ?? 0, `${id}'s dy`) + d[1]); return `${id}: ${at.dx}, ${at.dy} from the room's centre`; }
    at.x = r1(num(at.x, `${id}'s x`) + d[0]); at.y = r1(num(at.y, `${id}'s y`) + d[1]);
    return `${id}: at ${at.x}, ${at.y}`;
  }
  if (k === "door" || k === "window") {
    const m = /^(door|window)@(\w+):(.+):([^:#]+)(?:#\d+)?$/.exec(e.key);
    if (!m) throw new Error(`Can't read the key ${e.key}`);
    const [, kind, wall, family, type] = m;
    const list: any[] = room.openings ?? [];
    // by its type when built; once retyped (an earlier edit adopted), the one such opening on that wall
    const same = list.map((o, j) => [o, j] as const).filter(([o]) => o.kind === kind && o.wall === wall && o.family === family);
    const i = same.find(([o]) => o.type === type)?.[1] ?? (same.length === 1 ? same[0][1] : -1);
    if (i < 0) throw new Error(`The recipe has no ${kind} ${type} on the ${wall} wall any more`);
    if (e.kind === "deleted") { list.splice(i, 1); return `The ${kind} ${type} taken out of the ${wall} wall`; }
    if (e.kind === "retyped") { list[i].type = e.now; return `The ${kind} on the ${wall} wall is now ${e.now}`; }
    if (e.kind === "param") { list[i].sill = num(e.now, "the sill"); return `The window's sill is ${e.now}`; }
    list[i].along = r1(num(list[i].along, `the ${kind}'s along`) + dot(e.delta_mm!, FRAME[wall as WallSide].dir));
    return `The ${kind} ${type}: ${list[i].along} along the ${wall} wall`;
  }
  if (k === "ceiling") {
    if (!room.ceiling) throw new Error("The recipe has no ceiling any more");
    if (e.kind === "retyped") { room.ceiling.type = e.now; return `The ceiling is now ${e.now}`; }
    room.ceiling.height = num(e.now, "the ceiling height"); return `The ceiling is at ${e.now}`;
  }
  throw new Error(`${e.key} can't be adopted`);
}
