/**
 * Casework Assistant engine (Engineer › Casework, +Model; boards CW_Overview, CW_Pane, CW_Outputs). Pure: no Revit.
 *
 *   run (walls, openings, fixed sink and appliances, modules) → units → panels → cut list → sheet nesting
 *   → edge banding → hardware → worktop → cost from the kit's material library → workshop pack files.
 *
 * Every dimension is a design input (the workshop's standards) and every board is a kit material: nothing here has a
 * default size, board or price (CLAUDE.md rules 5 and 7). The reference maths is the example kitchen on the boards
 * (cw_kitchen.py): 12 units, 120 pieces, 15 sheets, 98.5 m of edge banding, 4.8 m of worktop, 28 hinges.
 */

// ---------------------------------------------------------------------------------------------------------------
// Workshop standards (design inputs; the kit has no casework standards file yet, so they come from the call)

export interface Standards {
  sheet: { length: number; width: number };
  kerf: number;
  carcass_board: string;
  carcass_thickness: number;
  front_board: string;
  back_board: string;
  /** Kit material for the edge band; optional (without it the edge banding is "price needed") */
  edge_band?: string;
  /** Kit material for the worktop; optional */
  worktop?: string;
  worktop_depth: number;
  base: { height: number; depth: number };
  wall: { height: number; depth: number };
  tall: { height: number; depth: number };
  plinth: number;
  /** How far a corner unit's return runs along the next wall (the worktop depth in an L) */
  corner_return: number;
  construction: {
    front_gap: number;
    back_clearance: number;
    top_rail: number;
    top_rails: number;
    sink_top_rails: number;
    shelf_setback: number;
    shelf_clearance: number;
    blind_panel: number;
    corner_door: number;
    drawer: {
      side_length: number;
      side_drop: number;
      back_allowance: number;
      bottom_allowance: number;
      bottom_depth: number;
      /** Drawer front heights before the front gap, by number of drawers: {"2": [287, 430], "3": [140, 287, 287]} */
      heights: Record<string, number[]>;
    };
  };
  shelves: { base: number; wall: number; tall: number };
  hardware: {
    hinges_per_door: number;
    hinges_per_tall_door: number;
    legs: number;
    legs_wide: number;
    legs_wide_from: number;
    shelf_pins_per_shelf: number;
    hangers_per_wall_unit: number;
    runner_length: number;
  };
}

/** Every field a complete set of standards needs, as dotted paths. */
export const STANDARD_FIELDS: string[] = [
  "sheet.length", "sheet.width", "kerf", "carcass_board", "carcass_thickness", "front_board", "back_board", "worktop_depth",
  "base.height", "base.depth", "wall.height", "wall.depth", "tall.height", "tall.depth", "plinth", "corner_return",
  "construction.front_gap", "construction.back_clearance", "construction.top_rail", "construction.top_rails",
  "construction.sink_top_rails", "construction.shelf_setback", "construction.shelf_clearance", "construction.blind_panel",
  "construction.corner_door", "construction.drawer.side_length", "construction.drawer.side_drop",
  "construction.drawer.back_allowance", "construction.drawer.bottom_allowance", "construction.drawer.bottom_depth",
  "construction.drawer.heights", "shelves.base", "shelves.wall", "shelves.tall", "hardware.hinges_per_door",
  "hardware.hinges_per_tall_door", "hardware.legs", "hardware.legs_wide", "hardware.legs_wide_from",
  "hardware.shelf_pins_per_shelf", "hardware.hangers_per_wall_unit", "hardware.runner_length",
];

const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Kit standards first, the call's values over them (a project's own choice wins); nested objects merge. */
export function mergeStandards(kit: unknown, given: unknown): Record<string, unknown> {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isObj(a)) return b === undefined ? a : b;
    if (!isObj(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  };
  return (merge(isObj(kit) ? kit : {}, isObj(given) ? given : {}) ?? {}) as Record<string, unknown>;
}

/** Missing or non-positive fields; nothing is filled in. */
export function checkStandards(s: unknown): { standards: Standards | null; missing: string[]; problems: string[] } {
  const missing: string[] = [];
  const problems: string[] = [];
  for (const f of STANDARD_FIELDS) {
    const v = get(s, f);
    if (v === undefined || v === null || v === "") { missing.push(f); continue; }
    if (f.endsWith("_board")) { if (typeof v !== "string") problems.push(`${f} is a kit material name`); continue; }
    if (f === "construction.drawer.heights") {
      if (!isObj(v) || Object.values(v).some((h) => !Array.isArray(h) || h.some((x) => typeof x !== "number" || !(x > 0))))
        problems.push(`${f} is {"<number of drawers>": [heights in mm]}`);
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) problems.push(`${f} must be a number ≥ 0 (mm or a count)`);
  }
  for (const f of ["sheet.length", "sheet.width", "carcass_thickness", "base.height", "base.depth", "wall.height", "wall.depth", "tall.height", "tall.depth"])
    if (get(s, f) === 0) problems.push(`${f} can't be 0`);
  if (missing.length || problems.length) return { standards: null, missing, problems };
  return { standards: s as unknown as Standards, missing, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// Units

export type UnitKind = "corner" | "base" | "sink" | "tall" | "wall" | "gap";
export interface Unit {
  mark: string;
  kind: UnitKind;
  width: number;
  wall: string;
  /** From the wall's start, mm */
  offset: number;
  /** door, 2door, <n>drawer, none; for a gap: what stands there (cooker, fridge, hood, dishwasher, …) */
  fronts: string;
  layer: "base" | "wall";
  drawer_heights?: number[];
}
export interface Filler { wall: string; layer: "base" | "wall"; offset: number; width: number }
export interface WorktopRun { wall: string; from: number; to: number; length: number }

export interface Opening { kind: "window" | "door"; offset: number; width: number }
export interface Fixed {
  /** sink is a unit; the rest are gaps for appliances */
  kind: "sink" | "cooker" | "fridge" | "dishwasher" | "washer" | "appliance";
  offset: number;
  width: number;
  /** cooker: a hood above it (a gap in the wall units) */
  hood?: boolean;
  /** an appliance that rises above the worktop (fridge is tall by default) */
  tall?: boolean;
  fronts?: string;
}
export interface RunWall {
  name: string;
  length: number;
  /** This wall holds the corner unit at this end */
  corner?: "start" | "end";
  /** The neighbouring wall's corner unit returns along this end (corner_return long) */
  after_corner?: "start" | "end";
  openings?: Opening[];
  fixed?: Fixed[];
  tall?: { at: "start" | "end"; width: number; fronts?: string };
}
export interface Run {
  walls: RunWall[];
  /** Unit widths the fill may use, mm */
  modules: number[];
  /** Wall-unit widths, if not the same as modules */
  wall_modules?: number[];
  corner_width?: number;
  /** Fronts by mark, over the defaults (base and wall: door up to 600, else 2door; sink 2door; corner door; tall 2door) */
  fronts?: Record<string, string>;
  /** Drawer front heights by mark, over the standards */
  drawer_heights?: Record<string, number[]>;
  mark_prefix?: { base?: string; wall?: string };
}

export interface Layout { units: Unit[]; fillers: Filler[]; worktop: WorktopRun[]; problems: string[]; notes: string[] }

const FRONTS = /^(door|2door|[1-6]drawer|none)$/;

function defaultFronts(kind: UnitKind, width: number): string {
  if (kind === "sink" || kind === "tall") return "2door";
  if (kind === "corner") return "door";
  return width <= 600 ? "door" : "2door";
}

/** Largest module that fits, again and again; what is left is a filler. */
export function greedyFill(length: number, modules: number[]): { widths: number[]; leftover: number } {
  const sizes = [...new Set(modules.filter((m) => m > 0))].sort((a, b) => b - a);
  const widths: number[] = [];
  let left = length;
  for (;;) {
    const m = sizes.find((x) => x <= left);
    if (m === undefined) break;
    widths.push(m);
    left -= m;
  }
  return { widths, leftover: left };
}

interface Slot { from: number; to: number; kind: "corner" | "return" | "sink" | "gap" | "door"; fixed?: Fixed }

/**
 * Units from a run: on each wall the corner unit, the corner return, fixed sinks and appliances and door openings
 * are placed first; each free stretch between them is filled from its start with the largest module that fits, the
 * tall unit packed first (at: start) or last (at: end) of its stretch, and what is left becomes a filler at the
 * stretch's end. Wall units sit over the base cabinets, never over a window, door, tall unit or cooker; a run of wall
 * units that starts at a window begins on the next base-unit line, so the joints line up with the base run.
 */
export function layoutRun(run: Run, s: Standards): Layout {
  const problems: string[] = [];
  const notes: string[] = [];
  const pb = run.mark_prefix?.base ?? "K";
  const pw = run.mark_prefix?.wall ?? "W";
  const modules = run.modules ?? [];
  const wallModules = run.wall_modules?.length ? run.wall_modules : modules;
  if (!modules.length) problems.push("Name the unit widths the fill may use (modules)");
  const base: Array<Omit<Unit, "mark">> = [];
  const upper: Array<Omit<Unit, "mark">> = [];
  const fillers: Filler[] = [];
  const worktop: WorktopRun[] = [];

  for (const w of run.walls ?? []) {
    const L = w.length;
    if (!(L > 0)) { problems.push(`Wall ${w.name}: the length is needed`); continue; }
    const slots: Slot[] = [];
    if (w.corner) {
      const cw = run.corner_width;
      if (!(cw && cw > 0)) problems.push(`Wall ${w.name}: a corner unit needs corner_width`);
      else slots.push(w.corner === "start" ? { from: 0, to: cw, kind: "corner" } : { from: L - cw, to: L, kind: "corner" });
    }
    if (w.after_corner) {
      const r = s.corner_return;
      slots.push(w.after_corner === "start" ? { from: 0, to: r, kind: "return" } : { from: L - r, to: L, kind: "return" });
    }
    for (const f of w.fixed ?? []) slots.push({ from: f.offset, to: f.offset + f.width, kind: f.kind === "sink" ? "sink" : "gap", fixed: f });
    for (const o of w.openings ?? []) if (o.kind === "door") slots.push({ from: o.offset, to: o.offset + o.width, kind: "door" });
    slots.sort((a, b) => a.from - b.from);
    for (const sl of slots) if (sl.from < 0 || sl.to > L) problems.push(`Wall ${w.name}: ${sl.fixed?.kind ?? sl.kind} at ${sl.from}–${sl.to} runs off the wall (${L})`);
    for (let i = 1; i < slots.length; i++)
      if (slots[i].from < slots[i - 1].to) problems.push(`Wall ${w.name}: ${slots[i - 1].fixed?.kind ?? slots[i - 1].kind} and ${slots[i].fixed?.kind ?? slots[i].kind} overlap at ${slots[i].from}`);

    // free stretches between the slots
    const free: Array<{ from: number; to: number }> = [];
    let at = 0;
    for (const sl of slots) { if (sl.from > at) free.push({ from: at, to: sl.from }); at = Math.max(at, sl.to); }
    if (at < L) free.push({ from: at, to: L });

    type Item = { from: number; to: number; unit?: Omit<Unit, "mark">; filler?: boolean; worktop: boolean; edge: boolean };
    const items: Item[] = [];
    for (const sl of slots) {
      if (sl.kind === "corner") items.push({ from: sl.from, to: sl.to, worktop: true, edge: true,
        unit: { kind: "corner", width: sl.to - sl.from, wall: w.name, offset: sl.from, fronts: "", layer: "base" } });
      else if (sl.kind === "return") items.push({ from: sl.from, to: sl.to, worktop: true, edge: false });
      else if (sl.kind === "sink") items.push({ from: sl.from, to: sl.to, worktop: true, edge: true,
        unit: { kind: "sink", width: sl.to - sl.from, wall: w.name, offset: sl.from, fronts: sl.fixed?.fronts ?? "", layer: "base" } });
      else if (sl.kind === "gap") {
        const f = sl.fixed!;
        const tall = f.tall ?? f.kind === "fridge";
        items.push({ from: sl.from, to: sl.to, worktop: !tall && f.kind !== "cooker", edge: false,
          unit: { kind: "gap", width: f.width, wall: w.name, offset: f.offset, fronts: f.kind, layer: "base" } });
      }
    }
    const tallIdx = w.tall ? (w.tall.at === "start" ? 0 : free.length - 1) : -1;
    if (w.tall && w.tall.at === "start" && free[0]?.from !== 0) problems.push(`Wall ${w.name}: the start is taken, so the tall unit can't stand there`);
    if (w.tall && w.tall.at === "end" && free[free.length - 1]?.to !== L) problems.push(`Wall ${w.name}: the end is taken, so the tall unit can't stand there`);
    free.forEach((fr, i) => {
      let len = fr.to - fr.from;
      let x = fr.from;
      const tallHere = i === tallIdx && w.tall;
      const tallW = tallHere ? w.tall!.width : 0;
      if (tallHere && tallW > len) { problems.push(`Wall ${w.name}: the tall unit (${tallW}) doesn't fit in ${len}`); return; }
      len -= tallW;
      const putTall = () => {
        items.push({ from: x, to: x + tallW, worktop: false, edge: true,
          unit: { kind: "tall", width: tallW, wall: w.name, offset: x, fronts: w.tall!.fronts ?? "", layer: "base" } });
        x += tallW;
      };
      if (tallHere && w.tall!.at === "start") putTall();
      const { widths, leftover } = greedyFill(len, modules);
      for (const wd of widths) {
        items.push({ from: x, to: x + wd, worktop: true, edge: true, unit: { kind: "base", width: wd, wall: w.name, offset: x, fronts: "", layer: "base" } });
        x += wd;
      }
      if (tallHere && w.tall!.at === "end") putTall();
      if (leftover > 0) {
        const prev = items.filter((it) => it.to === x).pop();
        items.push({ from: x, to: x + leftover, filler: true, worktop: !!prev?.worktop && prev.unit?.kind !== "tall", edge: false });
        fillers.push({ wall: w.name, layer: "base", offset: x, width: leftover });
      }
    });
    items.sort((a, b) => a.from - b.from);
    for (const it of items) if (it.unit) base.push(it.unit);

    // worktop runs: contiguous items that carry a worktop
    let cur: WorktopRun | null = null;
    for (const it of items) {
      if (it.worktop && cur && it.from === cur.to) { cur.to = it.to; cur.length = cur.to - cur.from; continue; }
      if (cur) worktop.push(cur);
      cur = it.worktop ? { wall: w.name, from: it.from, to: it.to, length: it.to - it.from } : null;
    }
    if (cur) worktop.push(cur);

    // wall units over the base cabinets (corner, base, sink and the fillers between them)
    const cabinet = (it: Item) => (it.unit && ["corner", "base", "sink"].includes(it.unit.kind)) || (it.filler && it.worktop);
    const spans: Array<{ from: number; to: number }> = [];
    for (const it of items.filter(cabinet)) {
      const last = spans[spans.length - 1];
      if (last && last.to === it.from) last.to = it.to; else spans.push({ from: it.from, to: it.to });
    }
    const blocks = (w.openings ?? []).map((o) => ({ from: o.offset, to: o.offset + o.width }));
    const edges = [...new Set(items.filter((it) => it.unit && it.unit.kind !== "gap").flatMap((it) => [it.from, it.to]))].sort((a, b) => a - b);
    const wallSpans: Array<{ from: number; to: number }> = [];
    for (const sp of spans) {
      let parts = [{ ...sp, afterOpening: false }];
      for (const b of blocks) {
        parts = parts.flatMap((p) => {
          if (b.to <= p.from || b.from >= p.to) return [p];
          const out = [];
          if (b.from > p.from) out.push({ from: p.from, to: b.from, afterOpening: p.afterOpening });
          if (b.to < p.to) out.push({ from: b.to, to: p.to, afterOpening: true });
          return out;
        });
      }
      for (const p of parts) {
        const from = p.afterOpening ? (edges.find((e) => e >= p.from && e < p.to) ?? p.to) : p.from;
        if (p.to > from) wallSpans.push({ from, to: p.to });
      }
    }
    const upperItems: Array<Omit<Unit, "mark">> = [];
    for (const sp of wallSpans) {
      let x = sp.from;
      const { widths, leftover } = greedyFill(sp.to - sp.from, wallModules);
      for (const wd of widths) { upperItems.push({ kind: "wall", width: wd, wall: w.name, offset: x, fronts: "", layer: "wall" }); x += wd; }
      if (leftover > 0) fillers.push({ wall: w.name, layer: "wall", offset: x, width: leftover });
    }
    for (const f of w.fixed ?? []) if (f.kind === "cooker" && f.hood)
      upperItems.push({ kind: "gap", width: f.width, wall: w.name, offset: f.offset, fronts: "hood", layer: "wall" });
    upperItems.sort((a, b) => a.offset - b.offset);
    upper.push(...upperItems);
    if ((w.fixed ?? []).some((f) => f.kind === "cooker"))
      notes.push(`Wall ${w.name}: no wall unit is placed over the cooker; gas and hood clearances are the professional's to confirm (rule 5)`);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const units: Unit[] = [];
  base.forEach((u, i) => units.push({ ...u, mark: `${pb}${pad(i + 1)}` }));
  upper.forEach((u, i) => units.push({ ...u, mark: `${pw}${pad(i + 1)}` }));
  for (const u of units) {
    if (u.kind === "gap") continue;
    const f = run.fronts?.[u.mark] ?? (u.fronts || defaultFronts(u.kind, u.width));
    if (!FRONTS.test(f)) problems.push(`${u.mark}: fronts "${f}" is not door, 2door, <n>drawer or none`);
    u.fronts = f;
    const dh = run.drawer_heights?.[u.mark];
    if (dh) u.drawer_heights = dh;
  }
  for (const m of Object.keys(run.fronts ?? {})) if (!units.some((u) => u.mark === m)) problems.push(`fronts names ${m}, which isn't in the layout`);
  if (fillers.length) notes.push(`${fillers.length} filler(s) (${fillers.map((f) => `${f.wall} ${f.layer} ${f.width}`).join(", ")}): scribed on site from offcuts, not in the cut list`);
  return { units, fillers, worktop, problems, notes };
}

/** A unit list given directly (the unit editor): checked, nothing filled in. */
export function checkUnits(units: Unit[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const u of units) {
    if (seen.has(u.mark)) problems.push(`${u.mark} is in the list twice`);
    seen.add(u.mark);
    if (!(u.width > 0)) problems.push(`${u.mark}: the width is needed`);
    if (u.kind !== "gap" && !FRONTS.test(u.fronts)) problems.push(`${u.mark}: fronts "${u.fronts}" is not door, 2door, <n>drawer or none`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Panels

export interface Part {
  mark: string;
  part: string;
  length: number;
  width: number;
  material: string;
  qty: number;
  /** Lengths of the banded edges, mm (one entry per edge, per piece) */
  edges: number[];
}

function shelvesOf(u: Unit, s: Standards): number {
  if (u.kind === "wall") return s.shelves.wall;
  if (u.kind === "tall") return s.shelves.tall;
  if (u.kind === "sink" || /drawer$/.test(u.fronts)) return 0;
  return s.shelves.base;
}

export function partsFor(u: Unit, s: Standards): { parts: Part[]; problems: string[] } {
  const P: Part[] = [];
  const problems: string[] = [];
  if (u.kind === "gap") return { parts: P, problems };
  const box = u.kind === "wall" ? s.wall : u.kind === "tall" ? s.tall : s.base;
  const H = box.height, D = box.depth, W = u.width, T = s.carcass_thickness, c = s.construction;
  const car = s.carcass_board, fr = s.front_board, back = s.back_board;
  const inner = W - 2 * T;
  if (inner <= 0) { problems.push(`${u.mark}: ${W} is narrower than two carcass sides`); return { parts: P, problems }; }
  P.push({ mark: u.mark, part: "Side", length: H, width: D, material: car, qty: 2, edges: [H] });
  P.push({ mark: u.mark, part: "Bottom", length: inner, width: D, material: car, qty: 1, edges: [inner] });
  if (u.kind === "wall" || u.kind === "tall") P.push({ mark: u.mark, part: "Top", length: inner, width: D, material: car, qty: 1, edges: [inner] });
  else P.push({ mark: u.mark, part: "Top rail", length: inner, width: c.top_rail, material: car, qty: u.kind === "sink" ? c.sink_top_rails : c.top_rails, edges: [inner] });
  P.push({ mark: u.mark, part: "Back", length: W - c.back_clearance, width: H - c.back_clearance, material: back, qty: 1, edges: [] });
  const shelves = shelvesOf(u, s);
  if (shelves) P.push({ mark: u.mark, part: "Shelf", length: inner - c.shelf_clearance, width: D - c.shelf_setback, material: car, qty: shelves, edges: [inner - c.shelf_clearance] });
  if (u.kind === "corner") P.push({ mark: u.mark, part: "Blind panel", length: c.blind_panel, width: H, material: car, qty: 1, edges: [H] });
  const fh = H - c.front_gap;
  if (u.fronts === "door") {
    const dw = u.kind === "corner" ? c.corner_door : W - c.front_gap;
    P.push({ mark: u.mark, part: "Door", length: fh, width: dw, material: fr, qty: 1, edges: [fh, fh, dw, dw] });
  } else if (u.fronts === "2door") {
    const dw = W / 2 - c.front_gap;
    P.push({ mark: u.mark, part: "Door", length: fh, width: dw, material: fr, qty: 2, edges: [fh, fh, dw, dw] });
  } else if (/drawer$/.test(u.fronts)) {
    const n = Number(u.fronts[0]);
    const hs = u.drawer_heights ?? c.drawer.heights[String(n)];
    if (!hs || hs.length !== n) { problems.push(`${u.mark}: no drawer heights for ${n} drawers (standards construction.drawer.heights["${n}"])`); return { parts: P, problems }; }
    const stack = hs.reduce((a, b) => a + b, 0);
    if (stack > H) problems.push(`${u.mark}: the drawer fronts (${stack}) are taller than the carcass (${H})`);
    const d = c.drawer;
    hs.forEach((h, i) => {
      const k = i + 1;
      P.push({ mark: u.mark, part: `Drawer front ${k}`, length: W - c.front_gap, width: h - c.front_gap, material: fr, qty: 1, edges: [W - c.front_gap, W - c.front_gap, h - c.front_gap, h - c.front_gap] });
      P.push({ mark: u.mark, part: `Drawer side ${k}`, length: d.side_length, width: h - d.side_drop, material: car, qty: 2, edges: [d.side_length] });
      P.push({ mark: u.mark, part: `Drawer back ${k}`, length: inner - d.back_allowance, width: h - d.side_drop, material: car, qty: 2, edges: [inner - d.back_allowance] });
      P.push({ mark: u.mark, part: `Drawer bottom ${k}`, length: inner - d.bottom_allowance, width: d.bottom_depth, material: back, qty: 1, edges: [] });
    });
  }
  for (const p of P) if (!(p.length > 0 && p.width > 0)) problems.push(`${u.mark} ${p.part}: ${p.length} × ${p.width} isn't a panel; check the standards`);
  return { parts: P, problems };
}

export function allParts(units: Unit[], s: Standards): { parts: Part[]; problems: string[] } {
  const parts: Part[] = [];
  const problems: string[] = [];
  for (const u of units) { const r = partsFor(u, s); parts.push(...r.parts); problems.push(...r.problems); }
  return { parts, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// Nesting: guillotine shelf packing per board, rotation allowed (plain boards have no grain)

export interface Placed { x: number; y: number; l: number; w: number; label: string }
export interface Sheet { material: string; index: number; items: Placed[]; used_mm2: number; yield_pct: number }
export interface Nest { material: string; sheets: Sheet[]; parts: number; yield_pct: number; too_big: string[] }

export function nest(parts: Part[], material: string, sheet: { length: number; width: number }, kerf: number): Nest {
  const SL = Math.max(sheet.length, sheet.width), SW = Math.min(sheet.length, sheet.width);
  const pieces: Array<{ l: number; w: number; label: string }> = [];
  for (const p of parts) {
    if (p.material !== material) continue;
    for (let i = 0; i < p.qty; i++) pieces.push({ l: Math.max(p.length, p.width), w: Math.min(p.length, p.width), label: `${p.mark} ${p.part}` });
  }
  // stable sort: widest first, then longest (Array.prototype.sort is stable)
  pieces.sort((a, b) => b.w - a.w || b.l - a.l);
  type Row = { y: number; h: number; x: number };
  const sheets: Array<{ rows: Row[]; items: Placed[]; y: number }> = [];
  const tooBig: string[] = [];
  for (const { l, w, label } of pieces) {
    if (l > SL || w > SW) { tooBig.push(`${label} (${l} × ${w})`); continue; }
    let placed = false;
    for (const sh of sheets) {
      for (const row of sh.rows) {
        if (w <= row.h && row.x + l <= SL) { sh.items.push({ x: row.x, y: row.y, l, w, label }); row.x += l + kerf; placed = true; break; }
      }
      if (placed) break;
      if (sh.y + w <= SW) {
        sh.rows.push({ y: sh.y, h: w, x: l + kerf });
        sh.items.push({ x: 0, y: sh.y, l, w, label });
        sh.y += w + kerf;
        placed = true;
        break;
      }
    }
    if (!placed) sheets.push({ rows: [{ y: 0, h: w, x: l + kerf }], items: [{ x: 0, y: 0, l, w, label }], y: w + kerf });
  }
  const area = SL * SW;
  const out: Sheet[] = sheets.map((sh, i) => {
    const used = sh.items.reduce((a, it) => a + it.l * it.w, 0);
    return { material, index: i + 1, items: sh.items, used_mm2: used, yield_pct: Math.round((100 * used) / area) };
  });
  const used = out.reduce((a, s) => a + s.used_mm2, 0);
  return { material, sheets: out, parts: pieces.length - tooBig.length, yield_pct: out.length ? Math.round((100 * used) / (out.length * area)) : 0, too_big: tooBig };
}

/** Board materials in the order they first appear in the parts. */
export function boardsOf(parts: Part[]): string[] {
  return [...new Set(parts.map((p) => p.material))];
}

// ---------------------------------------------------------------------------------------------------------------
// Cut list, edge banding, hardware

export interface CutRow { mark: string; part: string; length: number; width: number; qty: number; board: string; edge: string; edge_m: number }

function edgeText(p: Part): string {
  if (!p.edges.length) return "—";
  if (p.edges.length === 4) return "4 sides";
  const long = Math.max(p.length, p.width);
  const words = p.edges.map((e) => (e === long ? "long" : "short"));
  if (words.every((x) => x === "long")) return `${p.edges.length} long edge${p.edges.length > 1 ? "s" : ""}`;
  if (words.every((x) => x === "short")) return `${p.edges.length} short edge${p.edges.length > 1 ? "s" : ""}`;
  return `${p.edges.length} edges`;
}

export function cutList(parts: Part[]): CutRow[] {
  return parts.map((p) => ({ mark: p.mark, part: p.part, length: p.length, width: p.width, qty: p.qty, board: p.material, edge: edgeText(p),
    edge_m: Math.round(p.edges.reduce((a, b) => a + b, 0) * p.qty) / 1000 }));
}

export function edgeMetres(parts: Part[]): number {
  return Math.round(parts.reduce((a, p) => a + p.edges.reduce((x, y) => x + y, 0) * p.qty, 0) / 100) / 10;
}

export interface HardwareRow { item: string; qty: number; unit: "nr" | "m" }

export function hardware(units: Unit[], s: Standards): HardwareRow[] {
  const h = s.hardware;
  let hinges = 0, runners = 0, handles = 0, legs = 0, pins = 0, hangers = 0, kick = 0;
  for (const u of units) {
    if (u.kind === "gap") continue;
    const doors = u.fronts === "door" ? 1 : u.fronts === "2door" ? 2 : 0;
    hinges += doors * (u.kind === "tall" ? h.hinges_per_tall_door : h.hinges_per_door);
    if (/drawer$/.test(u.fronts)) { const n = Number(u.fronts[0]); runners += n; handles += n; }
    handles += doors;
    if (u.kind !== "wall") { legs += u.width < h.legs_wide_from ? h.legs : h.legs_wide; kick += u.width; }
    pins += h.shelf_pins_per_shelf * shelvesOf(u, s);
    if (u.kind === "wall") hangers += h.hangers_per_wall_unit;
  }
  return [
    { item: "Hinges", qty: hinges, unit: "nr" },
    { item: `Drawer runners (pairs, ${h.runner_length} mm)`, qty: runners, unit: "nr" },
    { item: "Handles", qty: handles, unit: "nr" },
    { item: `Legs (adjustable ${s.plinth} mm)`, qty: legs, unit: "nr" },
    { item: "Shelf pins", qty: pins, unit: "nr" },
    { item: "Wall-unit hangers", qty: hangers, unit: "nr" },
    { item: "Kick board", qty: Math.round(kick / 100) / 10, unit: "m" },
  ];
}

export function worktopMetres(runs: WorktopRun[]): number {
  return Math.round(runs.reduce((a, r) => a + r.length, 0) / 100) / 10;
}

// ---------------------------------------------------------------------------------------------------------------
// Prices from the kit's material library (07_Materials\FMC_Materials.json): never invented

export interface LibPrice { ugx: string; unit: string; date: string; source: string; status: string }
export interface LibMaterial { name: string; price: LibPrice | null }

export function readLibrary(json: unknown): Map<string, LibMaterial> {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.materials) ? json.materials : [];
  const map = new Map<string, LibMaterial>();
  for (const m of list as Array<Record<string, unknown>>) {
    const name = typeof m?.name === "string" ? m.name.trim() : "";
    if (!name) continue;
    const p = isObj(m.price) ? m.price : null;
    map.set(name, { name, price: p ? { ugx: String(p.ugx ?? ""), unit: String(p.unit ?? ""), date: String(p.date ?? ""), source: String(p.source ?? ""), status: String(p.status ?? "") } : null });
  }
  return map;
}

/** "60,000-90,000" → [60000, 90000]; "105,000" → [105000, 105000]; anything else → null. */
export function parseUgx(ugx: string): [number, number] | null {
  const parts = ugx.split(/\s*[-–]\s*/).map((x) => x.replace(/[, ]/g, ""));
  if (!parts.length || parts.length > 2 || parts.some((x) => !/^\d+(\.\d+)?$/.test(x))) return null;
  const nums = parts.map(Number);
  return [nums[0], nums[nums.length - 1]];
}

type Basis = "sheet" | "m" | "m2";

/** What the library's price is per, when it is something the pack can multiply: a full sheet of this size, a metre, a square metre. */
export function priceBasis(unit: string, sheet: { length: number; width: number }): Basis | null {
  const u = unit.toLowerCase();
  const L = Math.max(sheet.length, sheet.width), W = Math.min(sheet.length, sheet.width);
  if (/sheet|board/.test(u)) {
    const ft = /8\s*x\s*4\s*ft|4\s*x\s*8\s*ft/.test(u) && L === 2440 && W === 1220;
    const mm = new RegExp(`${L}\\s*[x×]\\s*${W}|${W}\\s*[x×]\\s*${L}`).test(u);
    return ft || mm ? "sheet" : null;
  }
  if (/^per (linear )?m(etre)?\b(?!2|²)/.test(u)) return "m";
  if (/^per (m2|m²|sq\.? ?m)\b/.test(u)) return "m2";
  return null;
}

export interface CostLine {
  item: string;
  material: string;
  quantity: number;
  unit: string;
  ugx_low: number | null;
  ugx_high: number | null;
  price: string;
  status: string;
  source: string;
  date: string;
}
export interface KitRequest { item: string; request: string; why: string }

export interface CostInput {
  boards: Array<{ material: string; sheets: number }>;
  edge_m: number;
  worktop_m: number;
  hardware: HardwareRow[];
}

export function costs(q: CostInput, s: Standards, lib: Map<string, LibMaterial> | null): { lines: CostLine[]; total: { ugx_low: number; ugx_high: number; priced: number; price_needed: number }; kit_requests: KitRequest[] } {
  const lines: CostLine[] = [];
  const req: KitRequest[] = [];
  const line = (item: string, material: string, quantity: number, unit: string, basis: (b: Basis) => number | null) => {
    const base = { item, material, quantity, unit, ugx_low: null, ugx_high: null, status: "", source: "", date: "" };
    if (!material) return lines.push({ ...base, price: "price needed" });
    if (!lib) return lines.push({ ...base, price: "price needed: the kit's material library isn't readable" });
    const m = lib.get(material);
    if (!m) {
      req.push({ item: material, request: `Add ${material} to 07_Materials\\FMC_Materials.json`, why: `${item} uses it and the library has no such material` });
      return lines.push({ ...base, price: "price needed: not in the kit's material library" });
    }
    if (!m.price) return lines.push({ ...base, price: "price needed" });
    const range = parseUgx(m.price.ugx);
    const b = priceBasis(m.price.unit, s.sheet);
    const per = b ? basis(b) : null;
    const src = { status: m.price.status, source: m.price.source, date: m.price.date };
    if (!range) return lines.push({ ...base, ...src, price: `price needed: the library's price "${m.price.ugx}" isn't a number` });
    if (per === null) return lines.push({ ...base, ...src, price: `price needed: the library prices it "${m.price.unit}", which this quantity can't use` });
    const lo = Math.round(range[0] * per), hi = Math.round(range[1] * per);
    lines.push({ ...base, ...src, ugx_low: lo, ugx_high: hi, price: lo === hi ? `UGX ${lo.toLocaleString("en-US")}` : `UGX ${lo.toLocaleString("en-US")}–${hi.toLocaleString("en-US")}` });
  };
  for (const b of q.boards) line(`Board · ${b.sheets} sheets`, b.material, b.sheets, "sheet", (k) => (k === "sheet" ? b.sheets : null));
  line(`Edge banding · ${q.edge_m} m`, s.edge_band ?? "", q.edge_m, "m", (k) => (k === "m" ? q.edge_m : null));
  if (!s.edge_band) req.push({ item: "Edge band", request: "Add an edge-band material (e.g. 2 mm ABS or PVC, per metre) to 07_Materials\\FMC_Materials.json", why: "The library has no edge band, so the edge banding can't be priced" });
  if (q.worktop_m > 0) {
    line(`Worktop · ${q.worktop_m} m`, s.worktop ?? "", q.worktop_m, "m", (k) => (k === "m" ? q.worktop_m : k === "m2" ? (q.worktop_m * s.worktop_depth) / 1000 : null));
  }
  for (const h of q.hardware) if (h.qty > 0) lines.push({ item: h.item, material: "", quantity: h.qty, unit: h.unit, ugx_low: null, ugx_high: null, price: "price needed", status: "", source: "", date: "" });
  if (q.hardware.some((h) => h.qty > 0))
    req.push({ item: "Hardware", request: "Add a hardware price list (hinges, runners, handles, legs, shelf pins, hangers, kick board) to the kit", why: "The kit has no hardware prices; the pack shows \"price needed\" instead of a guess" });
  const priced = lines.filter((l) => l.ugx_low !== null);
  return {
    lines,
    total: { ugx_low: priced.reduce((a, l) => a + (l.ugx_low ?? 0), 0), ugx_high: priced.reduce((a, l) => a + (l.ugx_high ?? 0), 0), priced: priced.length, price_needed: lines.length - priced.length },
    kit_requests: req,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Everything at once

export interface Casework {
  layout: Layout;
  parts: Part[];
  nests: Nest[];
  cutlist: CutRow[];
  edge_m: number;
  worktop_m: number;
  hardware: HardwareRow[];
  problems: string[];
}

export function compute(units: Unit[], layout: Layout, s: Standards): Casework {
  const { parts, problems } = allParts(units, s);
  const nests = boardsOf(parts).map((m) => nest(parts, m, s.sheet, s.kerf));
  for (const n of nests) for (const t of n.too_big) problems.push(`${t} is bigger than a ${s.sheet.length} × ${s.sheet.width} sheet of ${n.material}`);
  return { layout, parts, nests, cutlist: cutList(parts), edge_m: edgeMetres(parts), worktop_m: worktopMetres(layout.worktop), hardware: hardware(units, s), problems: [...layout.problems, ...problems] };
}

export function summaryOf(c: Casework) {
  const units = c.layout.units.filter((u) => u.kind !== "gap");
  return {
    units: units.length,
    gaps: c.layout.units.filter((u) => u.kind === "gap").map((u) => `${u.mark} ${u.fronts} ${u.width}`),
    part_lines: c.parts.length,
    pieces: c.parts.reduce((a, p) => a + p.qty, 0),
    sheets: c.nests.reduce((a, n) => a + n.sheets.length, 0),
    boards: c.nests.map((n) => ({ material: n.material, sheets: n.sheets.length, parts: n.parts, yield_pct: n.yield_pct })),
    edge_m: c.edge_m,
    worktop_m: c.worktop_m,
    hardware: Object.fromEntries(c.hardware.map((h) => [h.item, h.qty])),
    fillers: c.layout.fillers,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Workshop pack: file names (the same inputs always give the same names) and contents

export function packLabel(label: string): string {
  return label.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function packNames(code: string, label: string): { cutlist: string; nesting: string; hardware: string; boq: string } {
  const stem = `${code}_Casework_${packLabel(label)}`;
  return { cutlist: `${stem}_CutList.csv`, nesting: `${stem}_Nesting.csv`, hardware: `${stem}_Hardware.csv`, boq: `${stem}_BoQ.csv` };
}

export function packFiles(c: Casework, cost: ReturnType<typeof costs>, csvLine: (f: Array<string | number | boolean>) => string, code: string, label: string): Array<{ name: string; content: string; rows: number }> {
  const n = packNames(code, label);
  const csv = (head: string[], rows: Array<Array<string | number>>) => [head, ...rows].map((r) => csvLine(r)).join("");
  const cut = c.cutlist.map((r) => [r.mark, r.part, r.length, r.width, r.qty, r.board, r.edge, r.edge_m]);
  const nestRows = c.nests.flatMap((ns) => ns.sheets.flatMap((sh) => sh.items.map((it) => [ns.material, sh.index, it.x, it.y, it.l, it.w, it.label])));
  const hw = c.hardware.map((h) => [h.item, h.qty, h.unit]);
  const boq = cost.lines.map((l) => [l.item, l.material, l.quantity, l.unit, l.ugx_low ?? "", l.ugx_high ?? "", l.price, l.status, l.source, l.date]);
  return [
    { name: n.cutlist, rows: cut.length, content: csv(["mark", "part", "length_mm", "width_mm", "qty", "board", "edge", "edge_m"], cut) },
    { name: n.nesting, rows: nestRows.length, content: csv(["board", "sheet", "x_mm", "y_mm", "length_mm", "width_mm", "part"], nestRows) },
    { name: n.hardware, rows: hw.length, content: csv(["item", "qty", "unit"], hw) },
    { name: n.boq, rows: boq.length, content: csv(["item", "material", "quantity", "unit", "ugx_low", "ugx_high", "price", "price_status", "source", "date"], boq) },
  ];
}
