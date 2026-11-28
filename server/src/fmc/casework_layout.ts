/** Casework engine: units from a run (layout), or a unit list checked. Part of casework.ts. */
import { Standards } from "./casework_standards.js";

// ---------------------------------------------------------------------------------------------------------------
// Units

/** wardrobe, vanity and basin are the fitted-room kinds (casework_fitted.ts) */
export type UnitKind = "corner" | "base" | "sink" | "tall" | "wall" | "gap" | "wardrobe" | "vanity" | "basin";
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
  /** sink (kitchen) and basin (vanity) are units; the rest are gaps for appliances */
  kind: "sink" | "basin" | "cooker" | "fridge" | "dishwasher" | "washer" | "appliance";
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
  /**
   * Where the wall's room-side face runs in the model, mm (CW2: read from the room, or given). The units stand on the
   * left of start → end, which is the room side of a room boundary read anticlockwise.
   */
  start?: [number, number];
  end?: [number, number];
  /** The room's side of start → end when it isn't the left (a wall given by hand, measured from a corner) */
  side?: "left" | "right";
  /** The Revit wall the face belongs to (from the room reading) */
  wall_id?: number;
}
export interface Run {
  /** kitchen (the default), wardrobe or vanity */
  kind?: "kitchen" | "wardrobe" | "vanity";
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

export const FRONTS = /^(door|2door|[1-6]drawer|none)$/;

export function defaultFronts(kind: UnitKind, width: number): string {
  if (kind === "sink" || kind === "tall" || kind === "basin") return "2door";
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
