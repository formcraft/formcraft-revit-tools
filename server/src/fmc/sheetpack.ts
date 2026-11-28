/**
 * Shelf pack for one sheet.
 * Each view uses the largest standard scale (smallest denominator) that is >= min_scale and fits the drawing zone.
 * A view that does not fit the leftover shelves steps to the next coarser scale. What still does not fit is overflow.
 * Titles on one shelf share a baseline. Boxes include the title band, so viewports do not overlap.
 * pair_small offers views from other sheets whose paper area is under 20% of the zone, and only when they fit the leftover space.
 */
export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000] as const;

/** FMC_TB_A1 drawing area from the sheets rulebook (SHT-013, SHT-014): origin 20,10 and 681 x 574 mm. */
export const KIT_A1 = { min_x: 20, min_y: 10, max_x: 701, max_y: 584, family: "FMC_TB_A1" };
/** FMC_TB_A0: A0 sheet 1189 x 841 with the same left and bottom margins and a 140 mm title strip. */
export const KIT_A0 = { min_x: 20, min_y: 10, max_x: 1049, max_y: 831, family: "FMC_TB_A0" };

const TITLE_MM = 12;
const SMALL_FRACTION = 0.2;

export interface Zone {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface PackView {
  id: string;
  name: string;
  sheet?: string;
  model_width_mm: number;
  model_height_mm: number;
  title_mm?: number;
  scale?: number;
}

export interface PackMove {
  view_id: string;
  name: string;
  center_x_mm: number;
  center_y_mm: number;
  width_mm: number;
  height_mm: number;
  title_mm: number;
  title_bottom_mm: number;
  scale: number;
  from_sheet?: string;
}

export interface PackOverflow {
  view_id: string;
  name: string;
  width_mm: number;
  height_mm: number;
  scale: number;
  zone_width_mm: number;
  zone_height_mm: number;
  shortfall_width_mm: number;
  shortfall_height_mm: number;
}

export interface ZoneChoice {
  zone: Zone;
  source: "titleblock_param" | "kit";
  family: string;
  provisional: boolean;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function zoneSize(zone: Zone): { width: number; height: number } {
  return { width: r1(zone.max_x - zone.min_x), height: r1(zone.max_y - zone.min_y) };
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * Drawing zone in millimetres, sheet origin at the lower left.
 * Title-block parameters win. Otherwise FMC_TB_A0 or FMC_TB_A1 from the kit spec.
 */
export function resolveZone(input: {
  family?: string;
  params?: Record<string, unknown>;
}): ZoneChoice | { code: string; reason: string } {
  const params = input.params ?? {};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = num(params[key]);
      if (value != null && value > 0) return value;
    }
    return null;
  };
  const width = pick("FMC_Drawing_Width", "Drawing Width", "Drawing Area Width");
  const height = pick("FMC_Drawing_Height", "Drawing Height", "Drawing Area Height");
  const family = (input.family ?? "").trim();
  if (width && height) {
    const left = pick("FMC_Drawing_Left", "Drawing Origin X", "Margin Left") ?? 20;
    const bottom = pick("FMC_Drawing_Bottom", "Drawing Origin Y", "Margin Bottom") ?? 10;
    return {
      zone: { min_x: r1(left), min_y: r1(bottom), max_x: r1(left + width), max_y: r1(bottom + height) },
      source: "titleblock_param",
      family: family || "title block",
      provisional: false,
    };
  }
  const blob = family.toUpperCase();
  if (blob.includes("A0")) return { zone: { ...KIT_A0 }, source: "kit", family: KIT_A0.family, provisional: false };
  if (blob.includes("A1") || /FMC[_ ]?(TB|TITLEBLOCK)/.test(blob)) return { zone: { ...KIT_A1 }, source: "kit", family: family || KIT_A1.family, provisional: false };
  return { code: "FMC-SHEETS-NO-FRAME", reason: "No FMC_TB_A0 or FMC_TB_A1 drawing area, and the title block has no drawing width and height." };
}

export function scalesFor(minScale: number): number[] {
  const min = Math.max(1, Math.floor(minScale || 1));
  return STANDARD_SCALES.filter((scale) => scale >= min);
}

function paper(view: PackView, scale: number, title: number): { width: number; height: number; title: number; cell: number } {
  const width = view.model_width_mm / scale;
  const height = view.model_height_mm / scale;
  return { width, height, title, cell: height + title };
}

function fitsZone(size: { width: number; cell: number }, zoneW: number, zoneH: number): boolean {
  return size.width <= zoneW + 0.1 && size.cell <= zoneH + 0.1;
}

interface Sized {
  view: PackView;
  scale: number;
  width: number;
  height: number;
  title: number;
  cell: number;
  from_sheet?: string;
}

function sizeAt(view: PackView, scale: number): Sized {
  const title = view.title_mm != null && view.title_mm >= 0 ? view.title_mm : TITLE_MM;
  const box = paper(view, scale, title);
  return { view, scale, width: box.width, height: box.height, title, cell: box.cell, from_sheet: view.sheet };
}

/** Largest scale (smallest denominator) >= min_scale whose paper size, including the title, fits the zone. */
export function chooseScale(view: PackView, zoneW: number, zoneH: number, minScale: number): number | null {
  for (const scale of scalesFor(minScale)) {
    const title = view.title_mm != null && view.title_mm >= 0 ? view.title_mm : TITLE_MM;
    if (fitsZone(paper(view, scale, title), zoneW, zoneH)) return scale;
  }
  return null;
}

function boxesOverlap(a: PackMove, b: PackMove): boolean {
  const a0 = { x0: a.center_x_mm - a.width_mm / 2, x1: a.center_x_mm + a.width_mm / 2, y0: a.title_bottom_mm, y1: a.center_y_mm + a.height_mm / 2 };
  const b0 = { x0: b.center_x_mm - b.width_mm / 2, x1: b.center_x_mm + b.width_mm / 2, y0: b.title_bottom_mm, y1: b.center_y_mm + b.height_mm / 2 };
  return a0.x0 < b0.x1 - 0.05 && b0.x0 < a0.x1 - 0.05 && a0.y0 < b0.y1 - 0.05 && b0.y0 < a0.y1 - 0.05;
}

function overflowOf(view: PackView, scale: number, zoneW: number, zoneH: number): PackOverflow {
  const title = view.title_mm != null && view.title_mm >= 0 ? view.title_mm : TITLE_MM;
  const box = paper(view, scale, title);
  return {
    view_id: view.id,
    name: view.name,
    width_mm: r1(box.width),
    height_mm: r1(box.cell),
    scale,
    zone_width_mm: r1(zoneW),
    zone_height_mm: r1(zoneH),
    shortfall_width_mm: r1(Math.max(0, box.width - zoneW)),
    shortfall_height_mm: r1(Math.max(0, box.cell - zoneH)),
  };
}

/**
 * Place `sized` into the zone. Returns the moves and the views that did not fit a shelf.
 * Shelf order is the input order. The caller sorts.
 */
function placeShelves(items: Sized[], zone: Zone, gap: number): { moves: PackMove[]; left: Sized[] } {
  const { width: zoneW, height: zoneH } = zoneSize(zone);
  const moves: PackMove[] = [];
  const left: Sized[] = [];
  let shelfTop = zone.max_y;
  let x = zone.min_x;
  let shelf: Sized[] = [];
  const flush = () => {
    if (!shelf.length) return;
    const shelfHeight = Math.max(...shelf.map((item) => item.cell));
    const titleBottom = shelfTop - shelfHeight;
    let cursor = zone.min_x;
    for (const item of shelf) {
      const centerX = cursor + item.width / 2;
      const viewportBottom = titleBottom + item.title;
      const centerY = viewportBottom + item.height / 2;
      const move: PackMove = {
        view_id: item.view.id,
        name: item.view.name,
        center_x_mm: r1(centerX),
        center_y_mm: r1(centerY),
        width_mm: r1(item.width),
        height_mm: r1(item.height),
        title_mm: r1(item.title),
        title_bottom_mm: r1(titleBottom),
        scale: item.scale,
        ...(item.from_sheet ? { from_sheet: item.from_sheet } : {}),
      };
      moves.push(move);
      cursor += item.width + gap;
    }
    shelfTop = titleBottom - gap;
    shelf = [];
    x = zone.min_x;
  };
  for (const item of items) {
    if (item.width > zoneW + 0.1 || item.cell > zoneH + 0.1) {
      left.push(item);
      continue;
    }
    const needsNew = shelf.length > 0 && x + item.width > zone.min_x + zoneW + 0.1;
    if (needsNew) flush();
    let shelfHeight = Math.max(item.cell, ...shelf.map((row) => row.cell), 0);
    if (shelf.length && shelfTop - shelfHeight < zone.min_y - 0.1) {
      flush();
      shelfHeight = item.cell;
    }
    if (shelfTop - shelfHeight < zone.min_y - 0.1) {
      left.push(item);
      continue;
    }
    shelf.push(item);
    x += item.width + gap;
  }
  flush();
  return { moves, left };
}

function coarsen(item: Sized, zoneW: number, zoneH: number, minScale: number): Sized | null {
  const scales = scalesFor(minScale).filter((scale) => scale > item.scale);
  for (const scale of scales) {
    const next = sizeAt(item.view, scale);
    next.from_sheet = item.from_sheet;
    if (fitsZone(next, zoneW, zoneH)) return next;
  }
  return null;
}

function bySize(a: Sized, b: Sized): number {
  return b.cell - a.cell || b.width - a.width || a.view.name.localeCompare(b.view.name);
}

/** Place the requested views, coarsening a view that does not fit a shelf. Then offer small views from other sheets. */
export function packSheet(input: {
  views: PackView[];
  others?: PackView[];
  zone: Zone;
  min_scale?: number;
  pair_small?: boolean;
  gap_mm?: number;
  sheet?: string;
}): { moves: PackMove[]; overflow: PackOverflow[]; proposed_pairs: PackMove[] } {
  const gap = input.gap_mm ?? 8;
  const minScale = input.min_scale ?? 1;
  const { width: zoneW, height: zoneH } = zoneSize(input.zone);
  const overflow: PackOverflow[] = [];
  let current: Sized[] = [];
  for (const view of input.views) {
    const scale = chooseScale(view, zoneW, zoneH, minScale);
    if (scale == null) {
      const coarsest = scalesFor(minScale).at(-1) ?? minScale;
      overflow.push(overflowOf(view, coarsest, zoneW, zoneH));
      continue;
    }
    current.push(sizeAt(view, scale));
  }
  current.sort(bySize);
  let placed = placeShelves(current, input.zone, gap);
  for (let attempt = 0; attempt < 16 && placed.left.length; attempt++) {
    const failed = new Set(placed.left.map((item) => item.view.id));
    let changed = false;
    const next: Sized[] = [];
    for (const item of current) {
      if (!failed.has(item.view.id)) {
        next.push(item);
        continue;
      }
      const coarser = coarsen(item, zoneW, zoneH, minScale);
      if (coarser) {
        next.push(coarser);
        changed = true;
      }
    }
    for (const item of placed.left) {
      if (!next.some((row) => row.view.id === item.view.id)) overflow.push(overflowOf(item.view, item.scale, zoneW, zoneH));
    }
    if (!changed) break;
    current = next.sort(bySize);
    placed = placeShelves(current, input.zone, gap);
  }
  for (const item of placed.left) {
    if (!overflow.some((row) => row.view_id === item.view.id)) overflow.push(overflowOf(item.view, item.scale, zoneW, zoneH));
  }
  const moves = placed.moves.filter((move) => !overflow.some((row) => row.view_id === move.view_id));
  const proposed = input.pair_small === false ? [] : pairInto(moves, input.others ?? [], input.zone, gap, minScale, zoneW, zoneH, input.sheet);
  for (let i = 0; i < moves.length; i++) {
    for (let j = i + 1; j < moves.length; j++) {
      if (boxesOverlap(moves[i], moves[j])) {
        throw new Error(`sheet pack overlapped ${moves[i].name} and ${moves[j].name}`);
      }
    }
  }
  return { moves, overflow, proposed_pairs: proposed };
}

/** Add a small view only when it sits in space the requested views left free. Requested moves stay where they are. */
function pairInto(moves: PackMove[], others: PackView[], zone: Zone, gap: number, minScale: number, zoneW: number, zoneH: number, sheet?: string): PackMove[] {
  const zoneArea = zoneW * zoneH;
  const proposed: PackMove[] = [];
  const taken = [...moves];
  const candidates = others
    .filter((view) => !sheet || !view.sheet || view.sheet !== sheet)
    .map((view) => ({ view, scale: chooseScale(view, zoneW, zoneH, minScale) }))
    .filter((row): row is { view: PackView; scale: number } => row.scale != null)
    .map((row) => sizeAt(row.view, row.scale))
    .filter((item) => item.width * item.cell < zoneArea * SMALL_FRACTION)
    .sort((a, b) => a.view.name.localeCompare(b.view.name));
  for (const item of candidates) {
    const spot = findSpot(taken, item, zone, gap);
    if (!spot) continue;
    taken.push(spot);
    proposed.push(spot);
  }
  return proposed;
}

function findSpot(taken: PackMove[], item: Sized, zone: Zone, gap: number): PackMove | null {
  const shelves = new Map<number, PackMove[]>();
  for (const move of taken) {
    const key = move.title_bottom_mm;
    const list = shelves.get(key) ?? [];
    list.push(move);
    shelves.set(key, list);
  }
  const bottoms = [...shelves.keys()].sort((a, b) => b - a);
  const tryAt = (titleBottom: number, cursor: number): PackMove | null => {
    const viewportBottom = titleBottom + item.title;
    const centerY = viewportBottom + item.height / 2;
    const centerX = cursor + item.width / 2;
    const move: PackMove = {
      view_id: item.view.id,
      name: item.view.name,
      center_x_mm: r1(centerX),
      center_y_mm: r1(centerY),
      width_mm: r1(item.width),
      height_mm: r1(item.height),
      title_mm: r1(item.title),
      title_bottom_mm: r1(titleBottom),
      scale: item.scale,
      ...(item.from_sheet ? { from_sheet: item.from_sheet } : {}),
    };
    const top = move.center_y_mm + move.height_mm / 2;
    if (move.center_x_mm + move.width_mm / 2 > zone.max_x + 0.1) return null;
    if (top > zone.max_y + 0.1 || titleBottom < zone.min_y - 0.1) return null;
    if (taken.some((other) => boxesOverlap(move, other))) return null;
    return move;
  };
  for (const bottom of bottoms) {
    const row = shelves.get(bottom) ?? [];
    const right = Math.max(...row.map((move) => move.center_x_mm + move.width_mm / 2));
    const spot = tryAt(bottom, right + gap);
    if (spot) return spot;
  }
  const lowest = bottoms.length ? Math.min(...bottoms) : zone.max_y;
  const shelfHeight = item.cell;
  const titleBottom = bottoms.length ? lowest - gap - shelfHeight : zone.max_y - shelfHeight;
  return tryAt(titleBottom, zone.min_x);
}
