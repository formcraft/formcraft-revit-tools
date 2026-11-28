/**
 * Join audit, hosting, room closure and the envelope pressure test.
 * The add-in returns one compact snapshot per action. This module decides the
 * findings, the verdict and the edit plan. It does not call Revit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  asNumber, citeJoins, opCap, verdictFor,
  type CitedValue, type JoinsBankEntry, type JoinsVerdict,
} from "./joins_bank.js";
import { skippedNonFamily, type SkippedNonFamily } from "./trace.js";

export const ID_CAP = 50;

export interface Xyz { x: number; y: number; z: number }

export interface PairRow {
  relation: string;
  a: string;
  b: string;
  end: number | null;
  gap_mm: number | null;
  overlap_mm: number | null;
  joined: boolean;
  open_end: boolean;
  attached: boolean;
  xyz: Xyz | null;
  pinned: boolean;
  checkout_a: string;
  checkout_b: string;
  owner_a: string;
  owner_b: string;
}

export interface HostRow {
  id: string;
  category: string;
  kind: string;
  host_id: string;
  host_category: string;
  level_id: string;
  offset_mm: number | null;
  float: string;
  outside: boolean;
  cuts: boolean | null;
  touching: boolean | null;
  should_host: boolean;
  candidates: string[];
  xyz: Xyz | null;
  move_mm: Xyz | null;
  pinned: boolean;
  checkout: string;
  owner: string;
}

export interface RoomRow {
  id: string;
  kind: string;
  number: string;
  name: string;
  level_id: string;
  area_m2: number | null;
  placed: boolean;
  enclosed: boolean | null;
  redundant: boolean;
  unbounded: boolean;
  boundary_gap_mm: number | null;
  xyz: Xyz | null;
}

export interface RoomWallRow {
  id: string;
  room_bounding: boolean;
  level_id: string;
  pinned: boolean;
  checkout: string;
  owner: string;
}

export interface LeakRow {
  code: string;
  xyz: Xyz | null;
  size_mm: number | null;
  ids: string[];
  relation: string;
  closed: boolean;
  definite: boolean;
}

export interface EnvelopeInfo {
  built: boolean;
  exterior_walls: number;
  roofs: number;
  floors: number;
  curtain: number;
  doors: number;
  windows: number;
  rays: number;
  voxels: number;
  booleans: number;
  capped: boolean;
  incomplete: boolean;
  reason: string;
}

export interface HeldRow { id: string; code: string; owner: string }

export interface JoinsSnapshot {
  resolved_document?: { title: string; path: string };
  is_central?: boolean;
  refused?: boolean;
  code?: string;
  message?: string;
  element_count?: number;
  scoped?: boolean;
  partial?: boolean;
  pairs: PairRow[];
  hosts: HostRow[];
  rooms: RoomRow[];
  room_walls: RoomWallRow[];
  leaks: LeakRow[];
  envelope?: EnvelopeInfo;
  images: { path: string }[];
  held: HeldRow[];
  active_unchanged?: boolean;
  skipped_non_family?: SkippedNonFamily;
}

export interface JoinsValues {
  gap_mm: number;
  overlap_mm: number;
  near_miss_mm: number;
  leak_min_mm: number;
  host_offset_mm: number;
  search_mm: number;
  scan_cap: number;
  voxel_mm: number;
  max_ops: number;
  max_rays: number;
  max_pairs: number;
}

export interface ResolvedLimits {
  fields: LimitField[];
  values: JoinsValues;
  cited: Record<string, CitedValue>;
}

export interface LimitField {
  key: string;
  value: number;
  source: "call" | "standards" | "provisional" | "unknown";
  clause: string;
  unit: string;
}

export interface JoinsFinding {
  code: string;
  ids: string[];
  xyz: Xyz | null;
  size_mm: number | null;
  relation: string;
  key: string;
  verdict: JoinsVerdict;
  standard: CitedValue;
  detail: string;
  end: number | null;
  pinned: boolean;
  host_id: string;
  candidates: string[];
  move_mm: Xyz | null;
  definite: boolean;
}

export interface FindingSummary {
  code: string;
  count: number;
  ids: string[];
  truncated: boolean;
  verdict: JoinsVerdict;
  key: string;
  standard: CitedValue;
  samples: { ids: string[]; xyz: Xyz | null; size_mm: number | null; relation: string }[];
}

export interface JoinOp {
  op: string;
  ids: string[];
  end?: number;
  host?: string;
  xyz?: Xyz;
  offset_mm?: number;
  move_mm?: Xyz;
  code: string;
  reason: string;
}

export interface FixPlan {
  ops: JoinOp[];
  skipped: { ids: string[]; code: string; reason: string }[];
  warnings: string[];
  capped: boolean;
  rule: string;
}

export type EnvelopeVerdict = "SEALED" | "LEAKS" | "UNKNOWN";

export interface PressureResult {
  verdict: EnvelopeVerdict;
  standard_verdict: JoinsVerdict;
  leaks: JoinsFinding[];
  reason: string;
  envelope?: EnvelopeInfo;
}

const VALUE_KEYS: (keyof JoinsValues)[] = [
  "gap_mm", "overlap_mm", "near_miss_mm", "leak_min_mm", "host_offset_mm",
  "search_mm", "scan_cap", "voxel_mm", "max_ops", "max_rays", "max_pairs",
];

const SPECIFIC: Record<string, string> = {
  wall_column: "JOIN-COLUMN",
  wall_framing: "JOIN-FRAMING",
  floor_edge: "JOIN-SLAB-EDGE",
  slab_edge: "JOIN-SLAB-EDGE",
  stair_floor: "JOIN-STAIR-FLOOR",
  railing_floor: "JOIN-RAILING-FLOOR",
  wall_wall: "JOIN-GAP",
};

function text(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function xyzOf(value: unknown): Xyz | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const x = num(row.x);
  const y = num(row.y);
  const z = num(row.z);
  if (x == null || y == null || z == null) return null;
  return { x, y, z };
}

function round(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  return String(Math.round(value * 10) / 10);
}

function over(value: number | null, limit: number): boolean {
  return value != null && value > limit + 1e-9;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function joinsDir(env: NodeJS.ProcessEnv = process.env): string {
  const over = (env.FMC_JOINS_DIR ?? "").trim();
  if (over) return over;
  const local = (env.LOCALAPPDATA ?? "").trim();
  if (local) return path.win32.join(local, "Formcraft", "joins");
  return path.join(os.tmpdir(), "Formcraft", "joins");
}

export function writeJoinsReport(dir: string, kind: string, body: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `joins-${kind}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

export function resolveJoinsLimits(
  overrides: Partial<Record<keyof JoinsValues, number>>,
  bank?: Record<string, JoinsBankEntry>,
): ResolvedLimits {
  const cited: Record<string, CitedValue> = {};
  const values = {} as JoinsValues;
  const fields: LimitField[] = [];
  for (const name of VALUE_KEYS) {
    const key = `joins.${name}`;
    const entry = citeJoins(key, bank);
    cited[key] = entry;
    const override = overrides[name];
    const fallback = asNumber(entry);
    const value = typeof override === "number" && Number.isFinite(override) ? override : (fallback ?? 0);
    values[name] = value;
    const unit = name.endsWith("_mm") ? "mm" : "count";
    fields.push({
      key,
      value,
      source: typeof override === "number" ? "call" : entry.source,
      clause: typeof override === "number" ? `Call override. ${entry.clause}` : entry.clause,
      unit,
    });
  }
  values.scan_cap = Math.floor(clamp(values.scan_cap, 1, 5000));
  values.max_ops = Math.floor(clamp(values.max_ops, 1, 50));
  values.max_rays = Math.floor(clamp(values.max_rays, 1, 96));
  values.max_pairs = Math.floor(clamp(values.max_pairs, 1, 2000));
  values.voxel_mm = Math.max(50, values.voxel_mm);
  return { fields, values, cited };
}

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function normalizeSnapshot(raw: unknown): JoinsSnapshot {
  const body = row(raw);
  const pairs = (Array.isArray(body.pairs) ? body.pairs : []).map((item) => {
    const r = row(item);
    return {
      relation: text(r.relation) || "wall_wall",
      a: text(r.a),
      b: text(r.b),
      end: num(r.end),
      gap_mm: num(r.gap_mm),
      overlap_mm: num(r.overlap_mm),
      joined: r.joined === true,
      open_end: r.open_end === true,
      attached: r.attached === true,
      xyz: xyzOf(r.xyz),
      pinned: r.pinned === true || r.pinned_a === true || r.pinned_b === true,
      checkout_a: text(r.checkout_a),
      checkout_b: text(r.checkout_b),
      owner_a: text(r.owner_a),
      owner_b: text(r.owner_b),
    } satisfies PairRow;
  }).filter((item) => item.a);
  const hosts = (Array.isArray(body.hosts) ? body.hosts : []).map((item) => {
    const r = row(item);
    return {
      id: text(r.id),
      category: text(r.category),
      kind: text(r.kind) || "family",
      host_id: text(r.host_id),
      host_category: text(r.host_category),
      level_id: text(r.level_id),
      offset_mm: num(r.offset_mm),
      float: text(r.float),
      outside: r.outside === true,
      cuts: r.cuts === true ? true : r.cuts === false ? false : null,
      touching: r.touching === true ? true : r.touching === false ? false : null,
      should_host: r.should_host === true,
      candidates: Array.isArray(r.candidates) ? r.candidates.map((id) => text(id)).filter(Boolean) : [],
      xyz: xyzOf(r.xyz),
      move_mm: xyzOf(r.move_mm),
      pinned: r.pinned === true,
      checkout: text(r.checkout),
      owner: text(r.owner),
    } satisfies HostRow;
  }).filter((item) => item.id);
  const rooms = (Array.isArray(body.rooms) ? body.rooms : []).map((item) => {
    const r = row(item);
    return {
      id: text(r.id),
      kind: text(r.kind) || "room",
      number: text(r.number),
      name: text(r.name),
      level_id: text(r.level_id),
      area_m2: num(r.area_m2),
      placed: r.placed !== false,
      enclosed: r.enclosed === true ? true : r.enclosed === false ? false : null,
      redundant: r.redundant === true,
      unbounded: r.unbounded === true || r.placed === false,
      boundary_gap_mm: num(r.boundary_gap_mm),
      xyz: xyzOf(r.xyz),
    } satisfies RoomRow;
  }).filter((item) => item.id);
  const room_walls = (Array.isArray(body.room_walls) ? body.room_walls : []).map((item) => {
    const r = row(item);
    return {
      id: text(r.id),
      room_bounding: r.room_bounding !== false,
      level_id: text(r.level_id),
      pinned: r.pinned === true,
      checkout: text(r.checkout),
      owner: text(r.owner),
    } satisfies RoomWallRow;
  }).filter((item) => item.id);
  const leaks = (Array.isArray(body.leaks) ? body.leaks : []).map((item) => {
    const r = row(item);
    return {
      code: text(r.code) || "LEAK-GAP",
      xyz: xyzOf(r.xyz),
      size_mm: num(r.size_mm),
      ids: Array.isArray(r.ids) ? r.ids.map((id) => text(id)).filter(Boolean) : [text(r.a), text(r.b)].filter(Boolean),
      relation: text(r.relation),
      closed: r.closed === true,
      definite: r.definite === true,
    } satisfies LeakRow;
  });
  const env = body.envelope && typeof body.envelope === "object" ? row(body.envelope) : null;
  const envelope: EnvelopeInfo | undefined = env ? {
    built: env.built !== false,
    exterior_walls: num(env.exterior_walls) ?? 0,
    roofs: num(env.roofs) ?? 0,
    floors: num(env.floors) ?? 0,
    curtain: num(env.curtain) ?? 0,
    doors: num(env.doors) ?? 0,
    windows: num(env.windows) ?? 0,
    rays: num(env.rays) ?? 0,
    voxels: num(env.voxels) ?? 0,
    booleans: num(env.booleans) ?? 0,
    capped: env.capped === true,
    incomplete: env.incomplete === true,
    reason: text(env.reason),
  } : undefined;
  const images = (Array.isArray(body.images) ? body.images : []).map((item) => {
    const r = row(item);
    const file = text(r.path) || text(r.file);
    return file ? { path: file } : null;
  }).filter((item): item is { path: string } => item != null);
  const held = heldOf(body, pairs, hosts, room_walls);
  const doc = body.resolved_document && typeof body.resolved_document === "object" ? row(body.resolved_document) : null;
  return {
    pairs, hosts, rooms, room_walls, leaks, images, held,
    ...(envelope ? { envelope } : {}),
    ...(doc ? { resolved_document: { title: text(doc.title), path: text(doc.path) } } : {}),
    is_central: body.is_central === true,
    refused: body.refused === true,
    code: text(body.code),
    message: text(body.message),
    element_count: num(body.element_count) ?? undefined,
    scoped: body.scoped === true,
    partial: body.partial === true,
    active_unchanged: body.active_unchanged === true,
    skipped_non_family: skippedNonFamily({ skipped_non_family: body.skipped_non_family as SkippedNonFamily }),
  };
}

function pushHeld(into: HeldRow[], id: string, code: string, owner: string) {
  if (!id || !code) return;
  if (code !== "FMC-ELEM-OWNED-BY-OTHER" && code !== "FMC-ELEM-NOT-CURRENT") return;
  if (into.some((row) => row.id === id)) return;
  into.push({ id, code, owner });
}

function heldOf(body: Record<string, unknown>, pairs: PairRow[], hosts: HostRow[], walls: RoomWallRow[]): HeldRow[] {
  const into: HeldRow[] = [];
  for (const item of Array.isArray(body.held) ? body.held : []) {
    const r = row(item);
    pushHeld(into, text(r.id), text(r.code), text(r.owner));
  }
  for (const pair of pairs) {
    pushHeld(into, pair.a, pair.checkout_a, pair.owner_a);
    pushHeld(into, pair.b, pair.checkout_b, pair.owner_b);
  }
  for (const host of hosts) pushHeld(into, host.id, host.checkout, host.owner);
  for (const wall of walls) pushHeld(into, wall.id, wall.checkout, wall.owner);
  return into;
}

function makeFinding(
  code: string,
  ids: string[],
  xyz: Xyz | null,
  size: number | null,
  relation: string,
  key: string,
  cited: Record<string, CitedValue>,
  detail: string,
  extra: Partial<JoinsFinding> = {},
): JoinsFinding {
  const standard = cited[key] ?? citeJoins(key);
  return {
    code,
    ids: [...new Set(ids.filter(Boolean))],
    xyz,
    size_mm: size,
    relation,
    key,
    verdict: verdictFor(false, standard),
    standard,
    detail,
    end: extra.end ?? null,
    pinned: extra.pinned === true,
    host_id: extra.host_id ?? "",
    candidates: extra.candidates ?? [],
    move_mm: extra.move_mm ?? null,
    definite: extra.definite === true,
  };
}

function sizeBand(pair: PairRow, gap: number | null, limits: JoinsValues, cited: Record<string, CitedValue>, largeCode: string): JoinsFinding | null {
  if (gap != null && over(gap, limits.gap_mm) && !over(gap, limits.near_miss_mm)) {
    return makeFinding("JOIN-NEAR-MISS", [pair.a, pair.b], pair.xyz, gap, pair.relation, "joins.near_miss_mm", cited, `${pair.relation} is ${round(gap)} mm apart, inside the near-miss band`, { end: pair.end, pinned: pair.pinned });
  }
  if (over(gap, limits.near_miss_mm)) {
    return makeFinding(largeCode, [pair.a, pair.b], pair.xyz, gap, pair.relation, "joins.gap_mm", cited, `${pair.relation} gap ${round(gap)} mm`, { end: pair.end, pinned: pair.pinned });
  }
  return null;
}

export function classifyPair(pair: PairRow, limits: JoinsValues, cited: Record<string, CitedValue>): JoinsFinding | null {
  const overlap = pair.overlap_mm ?? 0;
  if (over(overlap, limits.overlap_mm)) {
    return makeFinding("JOIN-OVERLAP", [pair.a, pair.b], pair.xyz, overlap, pair.relation, "joins.overlap_mm", cited, `${pair.relation} overlaps ${round(overlap)} mm`, { end: pair.end, pinned: pair.pinned });
  }
  const gap = pair.gap_mm;
  if (pair.relation === "wall_roof") {
    if (!pair.attached || over(gap, limits.gap_mm)) {
      return makeFinding("JOIN-TOP-UNATTACHED", [pair.a, pair.b], pair.xyz, gap, pair.relation, "joins.gap_mm", cited, pair.attached ? `wall top is ${round(gap)} mm short of the roof` : "wall top is not attached", { end: pair.end, pinned: pair.pinned });
    }
    return null;
  }
  if (pair.relation === "wall_floor") {
    if (over(gap, limits.host_offset_mm) || (!pair.attached && over(gap, limits.gap_mm))) {
      return makeFinding("JOIN-BASE-OFFSET", [pair.a, pair.b], pair.xyz, gap, pair.relation, "joins.host_offset_mm", cited, `wall base is ${round(gap)} mm off the floor`, { end: pair.end, pinned: pair.pinned });
    }
    return null;
  }
  if (pair.relation === "wall_end" || (pair.relation === "curtain_wall" && pair.open_end)) {
    if (pair.open_end) {
      if (gap != null && over(gap, limits.gap_mm) && !over(gap, limits.near_miss_mm)) {
        return makeFinding("JOIN-NEAR-MISS", [pair.a, pair.b], pair.xyz, gap, pair.relation, "joins.near_miss_mm", cited, `unjoined end is ${round(gap)} mm from the next element`, { end: pair.end, pinned: pair.pinned });
      }
      const code = pair.relation === "curtain_wall" ? "JOIN-CURTAIN-OPEN" : "JOIN-WALL-END-OPEN";
      return makeFinding(code, [pair.a, pair.b], pair.xyz, gap, pair.relation, "joins.gap_mm", cited, "end is not joined", { end: pair.end, pinned: pair.pinned });
    }
    return sizeBand(pair, gap, limits, cited, "JOIN-GAP");
  }
  const large = SPECIFIC[pair.relation] ?? (pair.relation === "curtain_wall" ? "JOIN-CURTAIN-OPEN" : "JOIN-GAP");
  return sizeBand(pair, gap, limits, cited, large);
}

/**
 * Research 51 (fmc_joins doc, gap "likely double-counted overlaps"): the add-in can list one joint as a-b and b-a.
 * A pair is the same joint when the relation, the two ids (in any order), the end and the point (10 mm) match.
 */
export function dedupePairs(pairs: PairRow[]): { pairs: PairRow[]; duplicates: number } {
  const seen = new Set<string>();
  const out: PairRow[] = [];
  for (const pair of pairs) {
    const ids = [pair.a, pair.b].sort().join("|");
    const at = pair.xyz ? Object.values(pair.xyz as unknown as Record<string, number>).map((v) => Math.round(Number(v) * 100)).join(",") : "";
    // P-fmc_joins-03: a pair with two elements is one finding whichever element the read started from (A,B = B,A),
    // whatever end or point it was measured at. A row with one element (an open end) stays per end.
    const key = pair.a && pair.b ? `${pair.relation}|${ids}` : `${pair.relation}|${ids}|${pair.end ?? ""}|${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return { pairs: out, duplicates: pairs.length - out.length };
}

export function auditFindings(snapshot: JoinsSnapshot, limits: ResolvedLimits): JoinsFinding[] {
  return dedupePairs(snapshot.pairs).pairs.map((pair) => classifyPair(pair, limits.values, limits.cited)).filter((item): item is JoinsFinding => item != null);
}

/** Research 51: a read that looked at no element is not a verdict. */
export function notChecked(snapshot: JoinsSnapshot): boolean {
  return snapshot.element_count === 0;
}

function categoryWanted(want: string, host: HostRow): boolean {
  const needle = want.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${host.category} ${host.kind}`.toLowerCase();
  return hay === needle || hay.split(/\s+/).includes(needle) || host.category.toLowerCase() === needle || host.kind.toLowerCase() === needle;
}

export function hostingFindings(snapshot: JoinsSnapshot, limits: ResolvedLimits, category = ""): JoinsFinding[] {
  const out: JoinsFinding[] = [];
  for (const host of snapshot.hosts) {
    if (!categoryWanted(category, host)) continue;
    const ids = [host.id, host.host_id].filter(Boolean);
    const extra = { pinned: host.pinned, host_id: host.host_id, candidates: host.candidates, move_mm: host.move_mm };
    if (host.outside) {
      out.push(makeFinding("HOST-OUTSIDE", ids, host.xyz, host.offset_mm, host.kind, "joins.host_offset_mm", limits.cited, `${host.category || host.kind} sits outside its host`, extra));
      continue;
    }
    if (host.should_host && !host.host_id) {
      out.push(makeFinding("HOST-UNHOSTED", [host.id], host.xyz, host.offset_mm, host.kind, "joins.host_offset_mm", limits.cited, `${host.category || host.kind} has no host`, extra));
      continue;
    }
    if (host.cuts === false) {
      out.push(makeFinding("HOST-NOT-CUTTING", ids, host.xyz, null, host.kind, "joins.host_offset_mm", limits.cited, `${host.category || host.kind} does not cut its host`, extra));
      continue;
    }
    if (host.offset_mm != null && over(Math.abs(host.offset_mm), limits.values.host_offset_mm)) {
      const level = host.float === "level";
      out.push(makeFinding(level ? "HOST-FLOAT-LEVEL" : "HOST-OFFSET", ids, host.xyz, Math.abs(host.offset_mm), host.kind, "joins.host_offset_mm", limits.cited, level ? `offset ${round(host.offset_mm)} mm from its level` : `host offset ${round(host.offset_mm)} mm`, extra));
      continue;
    }
    if (host.touching === false && (host.kind === "fixture" || host.float === "fixture")) {
      out.push(makeFinding("HOST-NOT-TOUCHING", [host.id], host.xyz, host.offset_mm, host.kind, "joins.host_offset_mm", limits.cited, `${host.category || "fixture"} does not touch a wall or a floor`, extra));
    }
  }
  return out;
}

export function roomFindings(snapshot: JoinsSnapshot, limits: ResolvedLimits): JoinsFinding[] {
  const out: JoinsFinding[] = [];
  const min = limits.values.leak_min_mm;
  for (const room of snapshot.rooms) {
    const label = `${room.kind} ${room.number || room.name || room.id}`.trim();
    if (room.unbounded) {
      out.push(makeFinding("ROOM-UNBOUNDED", [room.id], room.xyz, null, room.kind, "joins.leak_min_mm", limits.cited, `${label} is not placed`, { definite: true }));
    } else if (room.redundant) {
      out.push(makeFinding("ROOM-REDUNDANT", [room.id], room.xyz, null, room.kind, "joins.leak_min_mm", limits.cited, `${label} is redundant`, { definite: true }));
    } else if (room.enclosed === false) {
      out.push(makeFinding("ROOM-NOT-ENCLOSED", [room.id], room.xyz, room.boundary_gap_mm, room.kind, "joins.leak_min_mm", limits.cited, `${label} is not enclosed`, { definite: true }));
    }
    if (room.boundary_gap_mm != null && over(room.boundary_gap_mm, min)) {
      out.push(makeFinding("ROOM-BOUNDARY-GAP", [room.id], room.xyz, room.boundary_gap_mm, room.kind, "joins.leak_min_mm", limits.cited, `${label} boundary gap ${round(room.boundary_gap_mm)} mm`));
    }
  }
  for (const wall of snapshot.room_walls) {
    if (wall.room_bounding) continue;
    out.push(makeFinding("ROOM-WALL-NOT-BOUNDING", [wall.id], null, null, "wall", "joins.leak_min_mm", limits.cited, "wall is not room-bounding", { pinned: wall.pinned, definite: true }));
  }
  return out;
}

function leakFinding(leak: LeakRow, cited: Record<string, CitedValue>): JoinsFinding {
  return makeFinding(leak.code, leak.ids, leak.xyz, leak.size_mm, leak.relation, "joins.leak_min_mm", cited, `${leak.code} ${round(leak.size_mm)} mm`, { definite: leak.definite });
}

export function pressureResult(snapshot: JoinsSnapshot, limits: ResolvedLimits, mode: "envelope" | "rooms"): PressureResult {
  const cited = limits.cited["joins.leak_min_mm"] ?? citeJoins("joins.leak_min_mm");
  const min = limits.values.leak_min_mm;
  const envelope = snapshot.envelope;
  if (mode === "rooms") {
    if (snapshot.rooms.length === 0 && snapshot.room_walls.length === 0) {
      return { verdict: "UNKNOWN", standard_verdict: "UNKNOWN", leaks: [], reason: "No rooms or spaces were in scope.", envelope };
    }
    const leaks = roomFindings(snapshot, limits).filter((item) => item.code !== "ROOM-WALL-NOT-BOUNDING" && (item.definite || (item.size_mm != null && item.size_mm >= min - 1e-9)));
    const unknownRoom = snapshot.rooms.some((room) => !room.unbounded && !room.redundant && room.enclosed == null && (room.boundary_gap_mm == null || room.boundary_gap_mm <= min));
    return finishPressure(leaks, cited, snapshot.partial === true, unknownRoom, envelope, "Every room in scope was checked.");
  }
  const raw = snapshot.leaks.filter((leak) => !leak.closed);
  const leaks = raw.filter((leak) => leak.definite || (leak.size_mm != null && leak.size_mm >= min - 1e-9)).map((leak) => leakFinding(leak, limits.cited));
  const incomplete = !envelope || envelope.incomplete || envelope.built === false;
  return finishPressure(leaks, cited, snapshot.partial === true || envelope?.capped === true, incomplete, envelope, envelope?.reason || "");
}

function finishPressure(
  leaks: JoinsFinding[],
  cited: CitedValue,
  capped: boolean,
  incomplete: boolean,
  envelope: EnvelopeInfo | undefined,
  reason: string,
): PressureResult {
  if (cited.source === "unknown" || cited.value == null) {
    return { verdict: "UNKNOWN", standard_verdict: "UNKNOWN", leaks, reason: cited.clause || "The leak tolerance is UNKNOWN.", envelope };
  }
  if (leaks.length > 0) {
    return { verdict: "LEAKS", standard_verdict: "FAIL", leaks, reason: `${leaks.length} leak path${leaks.length === 1 ? "" : "s"}.`, envelope };
  }
  if (incomplete) {
    return { verdict: "UNKNOWN", standard_verdict: verdictFor(true, cited), leaks: [], reason: reason || "The envelope could not be built.", envelope };
  }
  if (capped) {
    return { verdict: "UNKNOWN", standard_verdict: verdictFor(true, cited), leaks: [], reason: "The sample was capped before the envelope was fully searched.", envelope };
  }
  const clean = verdictFor(true, cited);
  if (clean !== "PASS") {
    return { verdict: "UNKNOWN", standard_verdict: clean, leaks: [], reason: "No leak in the sample. The tolerance is provisional, so the envelope is not called SEALED.", envelope };
  }
  return { verdict: "SEALED", standard_verdict: "PASS", leaks: [], reason: reason || "No leak path in the sample.", envelope };
}

const RANK: Record<JoinsVerdict, number> = { FAIL: 0, UNKNOWN: 1, PROVISIONAL: 2, PASS: 3 };

export function worstVerdict(list: JoinsVerdict[]): JoinsVerdict {
  if (!list.length) return "UNKNOWN";
  return list.reduce((left, right) => (RANK[left] <= RANK[right] ? left : right));
}

export function overallVerdict(findings: JoinsFinding[], cited: CitedValue[]): JoinsVerdict {
  if (findings.some((item) => item.verdict === "FAIL")) return "FAIL";
  // P-fmc_joins-02: findings against provisional limits are advisory: PROVISIONAL, never FAIL.
  if (findings.some((item) => item.verdict === "PROVISIONAL")) return cited.some((item) => item.source === "unknown" || item.value == null) ? "UNKNOWN" : "PROVISIONAL";
  if (findings.some((item) => item.verdict === "UNKNOWN")) return "UNKNOWN";
  if (cited.some((item) => item.source === "unknown" || item.value == null)) return "UNKNOWN";
  if (cited.some((item) => item.source === "provisional")) return "PROVISIONAL";
  if (!cited.length) return "UNKNOWN";
  return "PASS";
}

export function summarizeFindings(findings: JoinsFinding[], cap = ID_CAP): FindingSummary[] {
  const groups = new Map<string, JoinsFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.code) ?? [];
    list.push(finding);
    groups.set(finding.code, list);
  }
  return [...groups.entries()].map(([code, rows]) => {
    const ids = [...new Set(rows.flatMap((item) => item.ids))];
    return {
      code,
      count: rows.length,
      ids: ids.slice(0, cap),
      truncated: ids.length > cap,
      verdict: worstVerdict(rows.map((item) => item.verdict)),
      key: rows[0].key,
      standard: rows[0].standard,
      samples: rows.slice(0, Math.min(5, cap)).map((item) => ({
        ids: item.ids, xyz: item.xyz, size_mm: item.size_mm, relation: item.relation,
      })),
    };
  });
}

const AUDIT_KEYS = ["joins.gap_mm", "joins.overlap_mm", "joins.near_miss_mm", "joins.host_offset_mm"];
const HOST_KEYS = ["joins.host_offset_mm"];
const ROOM_KEYS = ["joins.leak_min_mm"];

export function standardsFor(keys: string[], cited: Record<string, CitedValue>): CitedValue[] {
  return keys.map((key) => cited[key] ?? citeJoins(key));
}

export function auditKeys(): string[] { return AUDIT_KEYS; }
export function hostKeys(): string[] { return HOST_KEYS; }
export function roomKeys(): string[] { return ROOM_KEYS; }

function heldSet(snapshot: JoinsSnapshot): Map<string, HeldRow> {
  return new Map(snapshot.held.map((row) => [row.id, row]));
}

export function planFixes(findings: JoinsFinding[], snapshot: JoinsSnapshot, limits: ResolvedLimits): FixPlan {
  const { cap } = opCap();
  const limit = Math.min(cap, limits.values.max_ops);
  const held = heldSet(snapshot);
  const ops: JoinOp[] = [];
  const skipped: FixPlan["skipped"] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  function blocked(ids: string[], pinned: boolean): boolean {
    if (pinned) {
      skipped.push({ ids, code: "JOIN-PINNED", reason: "Pinned elements are reported and left where they are." });
      return true;
    }
    const hit = ids.map((id) => held.get(id)).find((row) => row);
    if (hit) {
      skipped.push({ ids, code: hit.code, reason: hit.owner ? `Owned by ${hit.owner}. Ownership is not taken.` : "The element is not current. Ownership is not taken." });
      return true;
    }
    return false;
  }

  function push(op: JoinOp) {
    if (ops.length >= limit) return;
    const key = `${op.op}|${op.ids.join(",")}|${op.end ?? ""}|${op.host ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    ops.push(op);
  }

  for (const finding of findings) {
    if (ops.length >= limit) break;
    const ids = finding.ids;
    const far = finding.size_mm != null && finding.size_mm > limits.values.search_mm;
    if (finding.code === "JOIN-NEAR-MISS") {
      if (!finding.xyz || finding.end == null) {
        warnings.push(`${ids[0] || "a pair"} is a near miss without an endpoint to move.`);
        continue;
      }
      if (blocked(ids, finding.pinned)) continue;
      push({ op: "snap", ids: ids.slice(0, 1), end: finding.end, host: ids[1], xyz: finding.xyz, code: finding.code, reason: finding.detail });
      if (ids[1]) push({ op: "allow_join", ids: ids.slice(0, 1), end: finding.end, host: ids[1], code: finding.code, reason: "Allow the wall join at the snapped end." });
      if (ids[1]) push({ op: "join", ids: ids.slice(0, 2), host: ids[1], code: finding.code, reason: "Join the snapped elements." });
      continue;
    }
    if (finding.code === "JOIN-WALL-END-OPEN" || finding.code === "JOIN-CURTAIN-OPEN") {
      const close = finding.size_mm != null && finding.size_mm <= limits.values.gap_mm;
      if (ids.length >= 2 && close && finding.end != null) {
        if (blocked(ids, finding.pinned)) continue;
        push({ op: "allow_join", ids: ids.slice(0, 1), end: finding.end, host: ids[1], code: finding.code, reason: "Allow the wall join at this end." });
        push({ op: "join", ids: ids.slice(0, 2), code: finding.code, reason: "Join elements that already meet." });
      } else {
        warnings.push(`${ids[0] || "an end"} stays open. Extending past the near-miss tolerance is left for a person.`);
      }
      continue;
    }
    if (finding.code === "JOIN-TOP-UNATTACHED" && ids[1] && !far) {
      if (blocked(ids, finding.pinned)) continue;
      push({ op: "attach_top", ids: ids.slice(0, 1), host: ids[1], code: finding.code, reason: finding.detail });
      continue;
    }
    if (finding.code === "JOIN-BASE-OFFSET" && ids[1] && !far) {
      if (blocked(ids, finding.pinned)) continue;
      push({ op: "attach_base", ids: ids.slice(0, 1), host: ids[1], code: finding.code, reason: finding.detail });
      continue;
    }
    if (finding.code === "JOIN-OVERLAP") {
      if (finding.end == null || finding.size_mm == null || finding.size_mm > limits.values.near_miss_mm || !finding.xyz) {
        warnings.push(`${ids.join(" and ") || "a pair"} overlaps past an automatic trim.`);
        continue;
      }
      if (blocked(ids, finding.pinned)) continue;
      push({ op: "trim", ids: ids.slice(0, 1), end: finding.end, xyz: finding.xyz, code: finding.code, reason: finding.detail });
      continue;
    }
    if (finding.code === "HOST-OFFSET" || finding.code === "HOST-FLOAT-LEVEL" || finding.code === "HOST-UNHOSTED") {
      const candidates = finding.candidates.filter(Boolean);
      const host = finding.host_id || (candidates.length === 1 ? candidates[0] : "");
      if (candidates.length > 1 && !finding.host_id) {
        warnings.push(`${ids[0]} has ${candidates.length} possible hosts. It was not re-hosted.`);
        continue;
      }
      if (!host) {
        warnings.push(`${ids[0]} has no single host to attach to.`);
        continue;
      }
      if (far) {
        warnings.push(`${ids[0]} is farther than the search distance. It was not moved.`);
        continue;
      }
      if (blocked(ids, finding.pinned)) continue;
      push({
        op: "rehost", ids: ids.slice(0, 1), host, offset_mm: 0,
        ...(finding.move_mm ? { move_mm: finding.move_mm } : {}),
        code: finding.code, reason: finding.detail,
      });
      continue;
    }
    if (finding.code === "HOST-OUTSIDE" || finding.code === "HOST-NOT-CUTTING" || finding.code === "HOST-NOT-TOUCHING") {
      warnings.push(`${ids[0]} (${finding.code}) is reported and left for a person.`);
    }
  }
  const capped = findings.length > 0 && ops.length >= limit && seen.size >= limit;
  return {
    ops,
    skipped,
    warnings,
    capped,
    rule: "Join, snap and re-host only where the partner is unambiguous and inside the search distance. Pinned elements and elements another user owns are reported and not moved. Ownership is never taken.",
  };
}

export function catalogue() {
  return {
    tool: "fmc_joins",
    actions: ["checks", "limits", "audit", "hosting", "pressure_test", "rooms", "fix"],
    codes: [
      "JOIN-WALL-END-OPEN", "JOIN-GAP", "JOIN-OVERLAP", "JOIN-NEAR-MISS", "JOIN-TOP-UNATTACHED", "JOIN-BASE-OFFSET",
      "JOIN-CURTAIN-OPEN", "JOIN-SLAB-EDGE", "JOIN-COLUMN", "JOIN-FRAMING", "JOIN-STAIR-FLOOR", "JOIN-RAILING-FLOOR",
      "HOST-OUTSIDE", "HOST-NOT-CUTTING", "HOST-FLOAT-LEVEL", "HOST-OFFSET", "HOST-NOT-TOUCHING", "HOST-UNHOSTED",
      "ROOM-NOT-ENCLOSED", "ROOM-UNBOUNDED", "ROOM-REDUNDANT", "ROOM-WALL-NOT-BOUNDING", "ROOM-BOUNDARY-GAP",
      "LEAK-GAP", "LEAK-CORNER", "LEAK-ROOF-EDGE", "LEAK-FLOOR-EDGE", "LEAK-WALL-BASE",
      "JOIN-PINNED",
    ],
    verdicts: ["PASS", "FAIL", "PROVISIONAL", "UNKNOWN"],
    envelope: ["SEALED", "LEAKS", "UNKNOWN"],
    scope: "level, category, bbox, room, space or ids. An unscoped scan above joins.scan_cap is refused.",
    images: "Returned only when images is true. The read does not export a picture otherwise.",
    writes: "fmc_joins_apply, one transaction, at most 50 operations, with batch_lease. dry_run defaults to true.",
  };
}

export function hasScope(input: { level?: string; category?: string; room?: string; space?: string; ids?: string[]; bbox?: unknown }): boolean {
  if ((input.level ?? "").trim()) return true;
  if ((input.category ?? "").trim()) return true;
  if ((input.room ?? "").trim()) return true;
  if ((input.space ?? "").trim()) return true;
  if ((input.ids ?? []).some((id) => String(id).trim())) return true;
  return input.bbox != null && typeof input.bbox === "object";
}
