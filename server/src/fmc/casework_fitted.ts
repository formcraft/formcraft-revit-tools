/**
 * Fitted rooms beyond the kitchen: wardrobe and vanity runs. Part of casework.ts.
 *
 * A wardrobe or vanity run is straight: on each wall door openings (and, for wardrobes, windows) are kept clear and
 * each free stretch is filled from its start with the largest module that fits, what is left a filler at its end. A
 * vanity run's basins are fixed units like a kitchen sink, and the vanity carries a top (measured like a worktop). No
 * corner, corner return, tall or wall units. The sizes are the kit's (wardrobe.*, vanity.*, shelves.*): nothing defaulted.
 */
import { Standards } from "./casework_standards.js";
import { FRONTS, Filler, Layout, Run, RunWall, Unit, WorktopRun, defaultFronts, greedyFill, layoutRun } from "./casework_layout.js";

type Fitted = "wardrobe" | "vanity";
type Item = { from: number; to: number; unit?: Omit<Unit, "mark">; top: boolean };

/** Units from any run: a kitchen (layoutRun, unchanged) or a wardrobe or vanity run. */
export function layoutAny(run: Run, s: Standards): Layout {
  const kind = run.kind ?? "kitchen";
  if (kind === "kitchen") {
    const out = layoutRun(run, s);
    if ((run.walls ?? []).some((w) => (w.fixed ?? []).some((f) => f.kind === "basin")))
      out.problems.push('A basin belongs in a vanity run (run.kind "vanity"); a kitchen has a sink');
    return out;
  }
  if (kind !== "wardrobe" && kind !== "vanity")
    return { units: [], fillers: [], worktop: [], problems: [`run.kind "${kind}" is kitchen, wardrobe or vanity`], notes: [] };
  return layoutFitted(run, s, kind);
}

function kitchenOnly(w: RunWall, kind: Fitted): string[] {
  const p: string[] = [];
  if (w.corner || w.after_corner) p.push(`Wall ${w.name}: a ${kind} run is straight; corner units are kitchen-only`);
  if (w.tall) p.push(`Wall ${w.name}: tall units are kitchen-only; a ${kind} run fills with ${kind} units`);
  for (const f of w.fixed ?? []) if (!(kind === "vanity" && f.kind === "basin"))
    p.push(`Wall ${w.name}: a ${f.kind} doesn't go in a ${kind} run${kind === "vanity" ? " (only basins)" : ""}`);
  return p;
}

/** The kept-clear stretches and basins of one wall, sorted, with overlap and off-wall problems. */
function slotsOf(w: RunWall, kind: Fitted, problems: string[]) {
  const slots: Array<{ from: number; to: number; what: string; basin?: { fronts?: string } }> = [];
  for (const f of w.fixed ?? []) if (kind === "vanity" && f.kind === "basin") slots.push({ from: f.offset, to: f.offset + f.width, what: "basin", basin: f });
  for (const o of w.openings ?? []) if (o.kind === "door" || kind === "wardrobe") slots.push({ from: o.offset, to: o.offset + o.width, what: o.kind });
  slots.sort((a, b) => a.from - b.from);
  for (const sl of slots) if (sl.from < 0 || sl.to > w.length) problems.push(`Wall ${w.name}: ${sl.what} at ${sl.from}–${sl.to} runs off the wall (${w.length})`);
  for (let i = 1; i < slots.length; i++) if (slots[i].from < slots[i - 1].to) problems.push(`Wall ${w.name}: ${slots[i - 1].what} and ${slots[i].what} overlap at ${slots[i].from}`);
  return slots;
}

function fillWall(w: RunWall, kind: Fitted, modules: number[], fillers: Filler[], problems: string[]): Item[] {
  const slots = slotsOf(w, kind, problems);
  const items: Item[] = [];
  for (const sl of slots) if (sl.basin)
    items.push({ from: sl.from, to: sl.to, top: true, unit: { kind: "basin", width: sl.to - sl.from, wall: w.name, offset: sl.from, fronts: sl.basin.fronts ?? "", layer: "base" } });
  let at = 0;
  const free: Array<{ from: number; to: number }> = [];
  for (const sl of slots) { if (sl.from > at) free.push({ from: at, to: sl.from }); at = Math.max(at, sl.to); }
  if (at < w.length) free.push({ from: at, to: w.length });
  for (const fr of free) {
    let x = fr.from;
    const { widths, leftover } = greedyFill(fr.to - fr.from, modules);
    for (const wd of widths) { items.push({ from: x, to: x + wd, top: kind === "vanity", unit: { kind, width: wd, wall: w.name, offset: x, fronts: "", layer: "base" } }); x += wd; }
    if (leftover > 0) {
      items.push({ from: x, to: x + leftover, top: kind === "vanity" && widths.length > 0 });
      fillers.push({ wall: w.name, layer: "base", offset: x, width: leftover });
    }
  }
  return items.sort((a, b) => a.from - b.from);
}

function topsOf(wall: string, items: Item[]): WorktopRun[] {
  const out: WorktopRun[] = [];
  let cur: WorktopRun | null = null;
  for (const it of items) {
    if (it.top && cur && it.from === cur.to) { cur.to = it.to; cur.length = cur.to - cur.from; continue; }
    if (cur) out.push(cur);
    cur = it.top ? { wall, from: it.from, to: it.to, length: it.to - it.from } : null;
  }
  if (cur) out.push(cur);
  // a top that is only a filler (no unit under it) isn't a top
  return out.filter((t) => items.some((it) => it.unit && it.from >= t.from && it.to <= t.to));
}

export function layoutFitted(run: Run, s: Standards, kind: Fitted): Layout {
  const problems: string[] = [];
  const notes: string[] = [];
  const modules = run.modules ?? [];
  if (!modules.length) problems.push(`Name the ${kind} widths the fill may use (modules)`);
  if (run.wall_modules?.length || run.corner_width) problems.push(`wall_modules and corner_width are kitchen-only; a ${kind} run has neither`);
  const fillers: Filler[] = [], worktop: WorktopRun[] = [], base: Array<Omit<Unit, "mark">> = [];
  for (const w of run.walls ?? []) {
    if (!(w.length > 0)) { problems.push(`Wall ${w.name}: the length is needed`); continue; }
    problems.push(...kitchenOnly(w, kind));
    const items = fillWall(w, kind, modules, fillers, problems);
    for (const it of items) if (it.unit) base.push(it.unit);
    if (kind === "vanity") worktop.push(...topsOf(w.name, items));
  }
  const prefix = run.mark_prefix?.base ?? (kind === "wardrobe" ? "WR" : "V");
  const units: Unit[] = base.map((u, i) => ({ ...u, mark: `${prefix}${String(i + 1).padStart(2, "0")}` }));
  for (const u of units) {
    const f = run.fronts?.[u.mark] ?? (u.fronts || defaultFronts(u.kind, u.width));
    if (!FRONTS.test(f)) problems.push(`${u.mark}: fronts "${f}" is not door, 2door, <n>drawer or none`);
    u.fronts = f;
    const dh = run.drawer_heights?.[u.mark];
    if (dh) u.drawer_heights = dh;
  }
  for (const m of Object.keys(run.fronts ?? {})) if (!units.some((u) => u.mark === m)) problems.push(`fronts names ${m}, which isn't in the layout`);
  if (fillers.length) notes.push(`${fillers.length} filler(s) (${fillers.map((f) => `${f.wall} ${f.width}`).join(", ")}): scribed on site from offcuts, not in the cut list`);
  if (kind === "wardrobe") notes.push(`Wardrobes stand ${s.wardrobe?.height ?? "?"} high (kit): doors and windows are kept clear; ceiling height, scribe and fixing to the wall are site checks`);
  else notes.push("Basin positions, taps, waste and the vanity top's material are the professional's and the kit's; the top is measured like a worktop");
  return { units, fillers, worktop, problems, notes };
}
