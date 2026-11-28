/** Casework engine: panels, nesting, cut list, edge banding, hardware and worktop. Part of casework.ts. */
import { Standards } from "./casework_standards.js";
import { Unit, WorktopRun } from "./casework_layout.js";

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
  if (u.kind === "sink" || u.kind === "basin" || /drawer$/.test(u.fronts)) return 0;
  if (u.kind === "wardrobe") return s.shelves.wardrobe ?? 0;
  if (u.kind === "vanity") return s.shelves.vanity ?? 0;
  return s.shelves.base;
}

/** The carcass box a unit is built to: wall, tall, wardrobe, vanity (and basin), else base. */
export function boxOf(u: Pick<Unit, "kind">, s: Standards): { height: number; depth: number } {
  if (u.kind === "wall") return s.wall;
  if (u.kind === "tall") return s.tall;
  if (u.kind === "wardrobe" && s.wardrobe) return s.wardrobe;
  if ((u.kind === "vanity" || u.kind === "basin") && s.vanity) return s.vanity;
  return s.base;
}

/** Units with a full top panel (no top rails): wall, tall and wardrobe. */
const TOPPED = new Set(["wall", "tall", "wardrobe"]);

export function partsFor(u: Unit, s: Standards): { parts: Part[]; problems: string[] } {
  const P: Part[] = [];
  const problems: string[] = [];
  if (u.kind === "gap") return { parts: P, problems };
  const box = boxOf(u, s);
  const H = box.height, D = box.depth, W = u.width, T = s.carcass_thickness, c = s.construction;
  const car = s.carcass_board, fr = s.front_board, back = s.back_board;
  const inner = W - 2 * T;
  if (inner <= 0) { problems.push(`${u.mark}: ${W} is narrower than two carcass sides`); return { parts: P, problems }; }
  P.push({ mark: u.mark, part: "Side", length: H, width: D, material: car, qty: 2, edges: [H] });
  P.push({ mark: u.mark, part: "Bottom", length: inner, width: D, material: car, qty: 1, edges: [inner] });
  if (TOPPED.has(u.kind)) P.push({ mark: u.mark, part: "Top", length: inner, width: D, material: car, qty: 1, edges: [inner] });
  else P.push({ mark: u.mark, part: "Top rail", length: inner, width: c.top_rail, material: car, qty: u.kind === "sink" || u.kind === "basin" ? c.sink_top_rails : c.top_rails, edges: [inner] });
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
  let hinges = 0, runners = 0, handles = 0, legs = 0, pins = 0, hangers = 0, kick = 0, rail = 0, brackets = 0;
  for (const u of units) {
    if (u.kind === "gap") continue;
    const doors = u.fronts === "door" ? 1 : u.fronts === "2door" ? 2 : 0;
    hinges += doors * (u.kind === "tall" || u.kind === "wardrobe" ? h.hinges_per_tall_door : h.hinges_per_door);
    if (/drawer$/.test(u.fronts)) { const n = Number(u.fronts[0]); runners += n; handles += n; }
    handles += doors;
    if (u.kind !== "wall") { legs += u.width < h.legs_wide_from ? h.legs : h.legs_wide; kick += u.width; }
    pins += h.shelf_pins_per_shelf * shelvesOf(u, s);
    if (u.kind === "wall") hangers += h.hangers_per_wall_unit;
    if (u.kind === "wardrobe") { rail += u.width - 2 * s.carcass_thickness; brackets += 2; }
  }
  // wardrobe rows only when there are wardrobes, so a kitchen's hardware list (and its pack files) is unchanged
  const robe: HardwareRow[] = rail > 0 ? [{ item: "Hanging rail", qty: Math.round(rail / 100) / 10, unit: "m" }, { item: "Rail brackets", qty: brackets, unit: "nr" }] : [];
  return [
    { item: "Hinges", qty: hinges, unit: "nr" },
    { item: `Drawer runners (pairs, ${h.runner_length} mm)`, qty: runners, unit: "nr" },
    { item: "Handles", qty: handles, unit: "nr" },
    { item: `Legs (adjustable ${s.plinth} mm)`, qty: legs, unit: "nr" },
    { item: "Shelf pins", qty: pins, unit: "nr" },
    { item: "Wall-unit hangers", qty: hangers, unit: "nr" },
    { item: "Kick board", qty: Math.round(kick / 100) / 10, unit: "m" },
    ...robe,
  ];
}

export function worktopMetres(runs: WorktopRun[]): number {
  return Math.round(runs.reduce((a, r) => a + r.length, 0) / 100) / 10;
}

// ---------------------------------------------------------------------------------------------------------------
// Prices from the kit's material library (07_Materials\FMC_Materials.json): never invented
