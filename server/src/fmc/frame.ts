/**
 * RC frame planner, preliminary (owner 27 Oct: "let's just go with the RC frame"). From the architecture model's facts
 * and the load takedown: grids on the wall lines (one grid system per wall direction: Ogala's outbuilding sits at an
 * angle to the house), columns at wall corners, junctions and free ends (more where a span would pass max_span_mm),
 * beams on every wall line at each floor and ground beams under the ground-floor walls, pad footings; sizes from the
 * kit's rules; quantities; the modify_model ops that build it in the structural model.
 *
 * Sizes are first-pass only: beams span/12 (structure.rc_beam_depth_ratio), columns from the ULS axial load on their
 * tributary area at 0.4·fck + 0.67·fy·ρ (C25/30, B500, 1%), pads from the characteristic load on an assumed bearing
 * pressure (the geotechnical report the law requires replaces it). PRELIMINARY – NOT FOR CONSTRUCTION.
 */
import { Facts, FactWall, Pt, Std, inside, takedown } from "./loads.js";

export interface FrameOptions {
  max_span_mm?: number; tol_mm?: number; beam_width_mm?: number; bearing_kpa?: number; founding_depth_mm?: number;
  fck_mpa?: number; fy_mpa?: number; rho?: number; min_wall_mm?: number;
}

type XY = [number, number];
const r0 = (x: number) => Math.round(x);
const r2 = (x: number) => Math.round(x * 100) / 100;
const up = (x: number, step: number) => Math.ceil(x / step - 1e-9) * step;
const COL_SIZES = [230, 250, 300, 350, 400, 450, 500, 600];
const angOf = (w: FactWall) => ((Math.atan2(w.end_mm[1] - w.start_mm[1], w.end_mm[0] - w.start_mm[0]) * 180) / Math.PI + 360) % 90;
const angDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 90; return Math.min(d, 90 - d); };

/** The wall directions (deg, 0-90) that carry at least share of the wall length, longest first. */
export function wallDirections(walls: FactWall[], share = 0.05): number[] {
  const bins = new Map<number, number>();
  for (const w of walls) { const k = Math.round(angOf(w)) % 90; bins.set(k, (bins.get(k) ?? 0) + w.length_mm); }
  const total = [...bins.values()].reduce((a, b) => a + b, 0);
  const out: number[] = [];
  for (const [a, len] of [...bins].sort((x, y) => y[1] - x[1])) if (len >= share * total && !out.some((b) => angDiff(a, b) <= 3)) out.push(a);
  return out;
}

/** Clusters of values within tol, each its length-weighted centre. */
export function cluster(vals: Array<{ v: number; w: number }>, tol: number): number[] {
  const s = [...vals].sort((a, b) => a.v - b.v);
  const out: Array<{ sum: number; wt: number; last: number }> = [];
  for (const x of s) {
    const c = out[out.length - 1];
    if (c && x.v - c.last <= tol) { c.sum += x.v * x.w; c.wt += x.w; c.last = x.v; } else out.push({ sum: x.v * x.w, wt: x.w, last: x.v });
  }
  return out.map((c) => c.sum / c.wt);
}

export function letters(i: number): string {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I or O
  return i < A.length ? A[i] : A[Math.floor(i / A.length) - 1] + A[i % A.length];
}

interface Frame { angle: number; prefix: string; c: number; s: number }
const toUV = (fr: Frame, p: Pt | XY): XY => [p[0] * fr.c + p[1] * fr.s, -p[0] * fr.s + p[1] * fr.c];
const toXY = (fr: Frame, p: XY): XY => [r0(p[0] * fr.c - p[1] * fr.s), r0(p[0] * fr.s + p[1] * fr.c)];
interface Line { fr: Frame; dir: "u" | "v"; at: number; from: number; to: number; wall: FactWall; bottom: string; top: string }
interface Col { id: number; fr: Frame; uv: XY; xy: XY; bottom: string; top: string }

export function planFrame(f: Facts, std: Std, o: FrameOptions = {}) {
  const tol = o.tol_mm ?? 300, maxSpan = o.max_span_mm ?? 6000, bw = o.beam_width_mm ?? 230;
  const qa = o.bearing_kpa ?? std("foundations.bearing_assumed_kpa") ?? 150, found = o.founding_depth_mm ?? std("foundations.min_depth") ?? 1000;
  const fck = o.fck_mpa ?? 25, fy = o.fy_mpa ?? 500, rho = o.rho ?? 0.01;
  const ratio = Number(/span\/(\d+)/.exec(String(std("structure.rc_beam_depth_ratio") ?? "span/12"))?.[1] ?? 12);
  const minCol = Math.max(...([std("structure.rc_column_min") ?? [230, 230]].flat() as number[]));
  const warnings: string[] = [];
  const loads = takedown(f, std);
  const levels = [...f.levels].sort((a, b) => a.elevation_mm - b.elevation_mm);
  const elev = (n: string) => levels.find((l) => l.name === n)?.elevation_mm ?? NaN;

  // a wall's top: its top level, else the level its height reaches (±400 mm), else none (gables, parapets, free walls)
  const topOf = (w: FactWall): string => {
    if (w.top_level) return w.top_level;
    const z = elev(w.base_level) + w.height_mm;
    return levels.find((l) => Math.abs(l.elevation_mm - z) <= 400 && l.elevation_mm > elev(w.base_level))?.name ?? "";
  };
  const walls = f.walls.filter((w) => w.thickness_mm >= (o.min_wall_mm ?? 100) && w.length_mm >= 600 && !/curtain|glazing|CW\b/i.test(w.type));
  const free = walls.filter((w) => !topOf(w));
  if (free.length) warnings.push(`${free.length} walls reach no level above them (gables, parapets, garden walls): no columns or beams for them; tie gables to the roof, give parapets and garden walls their own footings`);
  const framed = walls.filter((w) => topOf(w));

  // ---- one grid system per wall direction
  const dirs = wallDirections(framed);
  const frames: Frame[] = dirs.map((a, i) => ({ angle: a, prefix: i === 0 ? "" : String.fromCharCode(65 + i), c: Math.cos((a * Math.PI) / 180), s: Math.sin((a * Math.PI) / 180) }));
  const lines: Line[] = [];
  for (const w of framed) {
    const fr = frames.reduce((b, x) => (angDiff(angOf(w), x.angle) < angDiff(angOf(w), b.angle) ? x : b), frames[0]);
    if (!fr || angDiff(angOf(w), fr.angle) > 3) { warnings.push(`wall ${w.id} (${w.type}) runs at ${angOf(w).toFixed(0)}°, off every grid: give it its own beams`); continue; }
    const a = toUV(fr, w.start_mm), b = toUV(fr, w.end_mm);
    const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    lines.push(horiz ? { fr, dir: "u", at: (a[1] + b[1]) / 2, from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]), wall: w, bottom: w.base_level, top: topOf(w) }
                     : { fr, dir: "v", at: (a[0] + b[0]) / 2, from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]), wall: w, bottom: w.base_level, top: topOf(w) });
  }
  const grids: Array<{ name: string; start_mm: XY; end_mm: XY }> = [];
  const gridAt = new Map<Frame, { u: number[]; v: number[] }>();
  for (const fr of frames) {
    const mine = lines.filter((l) => l.fr === fr);
    const gu = cluster(mine.filter((l) => l.dir === "u").map((l) => ({ v: l.at, w: l.to - l.from })), tol);
    const gv = cluster(mine.filter((l) => l.dir === "v").map((l) => ({ v: l.at, w: l.to - l.from })), tol);
    const snap = (x: number, g: number[]) => g.reduce((b, y) => (Math.abs(y - x) < Math.abs(b - x) ? y : b), g[0]);
    for (const l of mine) l.at = snap(l.at, l.dir === "u" ? gu : gv);
    const ext = (dir: "u" | "v", at: number) => { const ls = mine.filter((l) => l.dir === dir && l.at === at); return [Math.min(...ls.map((l) => l.from)) - 1500, Math.max(...ls.map((l) => l.to)) + 1500]; };
    gu.forEach((at, i) => { const [a, b] = ext("u", at); grids.push({ name: fr.prefix + letters(i), start_mm: toXY(fr, [a, at]), end_mm: toXY(fr, [b, at]) }); });
    gv.forEach((at, i) => { const [a, b] = ext("v", at); grids.push({ name: fr.prefix + String(i + 1), start_mm: toXY(fr, [at, a]), end_mm: toXY(fr, [at, b]) }); });
    gridAt.set(fr, { u: gu, v: gv });
  }

  // ---- columns per storey band (walls between the same two levels), per grid system
  const columns: Col[] = [];
  const nearXY = (p: XY, q: XY) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol * 1.5;
  const addCol = (fr: Frame, uv: XY, bottom: string, top: string) => {
    const xy = toXY(fr, uv);
    if (!columns.some((k) => k.bottom === bottom && k.top === top && nearXY(k.xy, xy))) columns.push({ id: columns.length + 1, fr, uv, xy, bottom, top });
  };
  const onLine = (l: Line, p: XY) => (l.dir === "u" ? Math.abs(p[1] - l.at) <= tol && p[0] >= l.from - tol && p[0] <= l.to + tol : Math.abs(p[0] - l.at) <= tol && p[1] >= l.from - tol && p[1] <= l.to + tol);
  const bandKeys = [...new Set(lines.map((l) => `${l.bottom}|${l.top}`))].sort((a, b) => elev(a.split("|")[0]) - elev(b.split("|")[0]));
  for (const key of bandKeys) {
    const [bottom, top] = key.split("|");
    for (const fr of frames) {
      const bl = lines.filter((l) => l.fr === fr && l.bottom === bottom && l.top === top);
      const us = bl.filter((l) => l.dir === "u"), vs = bl.filter((l) => l.dir === "v");
      for (const lu of us) for (const lv of vs) { const p: XY = [lv.at, lu.at]; if (onLine(lu, p) && onLine(lv, p)) addCol(fr, p, bottom, top); }
      for (const l of bl) for (const end of [l.from, l.to]) addCol(fr, l.dir === "u" ? [end, l.at] : [l.at, end], bottom, top);
      for (const dir of ["u", "v"] as const) for (const at of [...new Set(bl.filter((l) => l.dir === dir).map((l) => l.at))]) {
        const pos = columns.filter((k) => k.fr === fr && k.bottom === bottom && (dir === "u" ? Math.abs(k.uv[1] - at) <= tol : Math.abs(k.uv[0] - at) <= tol)).map((k) => (dir === "u" ? k.uv[0] : k.uv[1])).sort((x, y) => x - y);
        for (let i = 0; i + 1 < pos.length; i++) {
          const gap = pos[i + 1] - pos[i], mid = (pos[i] + pos[i + 1]) / 2;
          if (gap > maxSpan && bl.some((l) => l.dir === dir && l.at === at && l.from <= mid + tol && l.to >= mid - tol)) {
            const n = Math.ceil(gap / maxSpan);
            for (let j = 1; j < n; j++) { const x = pos[i] + (gap * j) / n; addCol(fr, dir === "u" ? [x, at] : [at, x], bottom, top); }
          }
        }
      }
    }
  }
  // a column above needs one below: continue it down where a wall line is, else flag a transfer beam
  for (const k of [...columns]) {
    if (columns.some((x) => x.top === k.bottom && nearXY(x.xy, k.xy))) continue;
    const below = lines.filter((l) => l.fr === k.fr && l.top === k.bottom && onLine(l, k.uv));
    if (below.length) addCol(k.fr, k.uv, below[0].bottom, below[0].top);
    else if (lines.some((l) => l.top === k.bottom)) warnings.push(`column at ${k.xy} (${k.bottom} to ${k.top}) has nothing under it: a transfer beam, or a column through the room below`);
  }

  // ---- beams between columns on each wall line: at the band's top (the floor it carries); ground beams at the lowest level
  const ground = bandKeys.length ? bandKeys[0].split("|")[0] : "";
  const beams: Array<{ level: string; start: XY; end: XY; span_mm: number; size_mm: [number, number]; ground: boolean }> = [];
  for (const key of bandKeys) {
    const [bottom, top] = key.split("|");
    for (const fr of frames) for (const dir of ["u", "v"] as const) {
      const bl = lines.filter((l) => l.fr === fr && l.bottom === bottom && l.top === top && l.dir === dir);
      for (const at of [...new Set(bl.map((l) => l.at))]) {
        const segs = bl.filter((l) => l.at === at);
        const pos = columns.filter((k) => k.fr === fr && (k.bottom === bottom || k.top === top) && (dir === "u" ? Math.abs(k.uv[1] - at) <= tol : Math.abs(k.uv[0] - at) <= tol))
          .map((k) => (dir === "u" ? k.uv[0] : k.uv[1])).sort((x, y) => x - y).filter((x, i, a) => i === 0 || x - a[i - 1] > tol);
        for (let i = 0; i + 1 < pos.length; i++) {
          const mid = (pos[i] + pos[i + 1]) / 2;
          if (!segs.some((l) => l.from <= mid && l.to >= mid)) continue;
          const span = pos[i + 1] - pos[i];
          const s: XY = toXY(fr, dir === "u" ? [pos[i], at] : [at, pos[i]]), e: XY = toXY(fr, dir === "u" ? [pos[i + 1], at] : [at, pos[i + 1]]);
          for (const lv of [top, ...(bottom === ground ? [bottom] : [])]) {
            const isGround = lv === ground;
            if (beams.some((x) => x.level === lv && nearXY(x.start, s) && nearXY(x.end, e))) continue;
            beams.push({ level: lv, start: s, end: e, span_mm: r0(span), size_mm: [bw, Math.max(isGround ? 400 : 300, up(span / ratio, 50))], ground: isGround });
          }
        }
      }
    }
  }

  // ---- column loads: each slab's ULS on its tributary area (the nearest column under it), wall weights to the columns
  // of the storey they stand on, roofs over the top columns; then summed down each stack
  const nUls = new Map<number, number>(), nSls = new Map<number, number>();
  const add = (id: number, u: number, s2: number) => { nUls.set(id, (nUls.get(id) ?? 0) + u); nSls.set(id, (nSls.get(id) ?? 0) + s2); };
  const nearestTo = (lvl: string, p: XY) => {
    const cand = columns.filter((k) => k.top === lvl); if (!cand.length) return null;
    return cand.reduce((b, k) => (Math.hypot(k.xy[0] - p[0], k.xy[1] - p[1]) < Math.hypot(b.xy[0] - p[0], b.xy[1] - p[1]) ? k : b), cand[0]);
  };
  const STEP = 500;
  for (const sl of loads.slabs) {
    const fl = f.floors.find((x) => x.id === sl.id); const loop = fl?.outline_mm?.[0]; if (!loop) continue;
    const xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]); let n = 0; const hits = new Map<number, number>();
    for (let x = Math.min(...xs) + STEP / 2; x < Math.max(...xs); x += STEP) for (let y = Math.min(...ys) + STEP / 2; y < Math.max(...ys); y += STEP) {
      if (!inside([x, y], fl!.outline_mm)) continue; n++;
      const k = nearestTo(sl.level, [x, y]); if (k) hits.set(k.id, (hits.get(k.id) ?? 0) + 1);
    }
    if (!hits.size) warnings.push(`slab ${sl.id} (${sl.level}) has no columns under it`);
    for (const [id, cnt] of hits) add(id, (cnt / n) * sl.area_m2 * sl.uls_kn_m2, (cnt / n) * sl.area_m2 * (sl.g + sl.q));
  }
  for (const w of loads.walls) {
    const fw = f.walls.find((x) => x.id === w.id)!;
    const k = nearestTo(fw.base_level, [(fw.start_mm[0] + fw.end_mm[0]) / 2, (fw.start_mm[1] + fw.end_mm[1]) / 2]);
    if (k) add(k.id, 1.35 * w.self_kn_m * w.length_m, w.self_kn_m * w.length_m);
  }
  const topCols = columns.filter((k) => !columns.some((x) => x.bottom === k.top && nearXY(x.xy, k.xy)));
  const roofG = loads.roofs.reduce((a, r) => a + r.total_g_kn, 0), roofQ = loads.roofs.reduce((a, r) => a + r.total_q_kn, 0);
  for (const k of topCols) add(k.id, (1.35 * roofG + 1.5 * roofQ) / topCols.length, (roofG + roofQ) / topCols.length);
  for (const k of [...columns].sort((a, b) => elev(b.bottom) - elev(a.bottom))) {
    const below = columns.find((x) => x.top === k.bottom && nearXY(x.xy, k.xy));
    if (below) add(below.id, nUls.get(k.id) ?? 0, nSls.get(k.id) ?? 0);
  }
  const need = (n: number) => (n * 1000) / (0.4 * fck + 0.67 * fy * rho);
  const colRows = columns.map((k) => {
    const N = nUls.get(k.id) ?? 0, side = COL_SIZES.find((x) => x >= Math.max(minCol, Math.sqrt(need(N)))) ?? 600;
    return { id: k.id, grid: k.fr.prefix || "main", at_mm: k.xy, bottom: k.bottom, top: k.top, height_mm: r0(elev(k.top) - elev(k.bottom)), n_uls_kn: r2(N), n_sls_kn: r2(nSls.get(k.id) ?? 0), size_mm: [side, side] as [number, number] };
  });

  // ---- pads under the ground columns
  const pads = colRows.filter((k) => k.bottom === ground).map((k) => {
    const N = k.n_sls_kn * 1.1;   // + the footing and the soil on it
    const B = Math.max(900, up(Math.sqrt(N / qa) * 1000, 100)), h = Math.max(300, up(0.3 * B, 50));
    return { column: k.id, at_mm: k.at_mm, size_mm: [B, B, h] as [number, number, number], n_sls_kn: k.n_sls_kn, pressure_kpa: r2(N / ((B / 1000) ** 2)) };
  });

  // ---- slab thickness against the span/depth rule (solid, continuous)
  const sd = std("slabs.span_depth_solid") ?? { continuous: 26, simply_supported: 20 };
  const slabChecks = loads.slabs.map((sl) => {
    const fl = f.floors.find((x) => x.id === sl.id)!; const loop = fl.outline_mm?.[0] ?? [];
    const struct = fl.layers.filter((l) => /structure/i.test(l.function)).reduce((a, l) => a + l.thickness_mm, 0);
    let best = Infinity;
    for (const fr of frames) {
      const g = gridAt.get(fr)!; const uv = loop.map((p) => toUV(fr, p));
      const umin = Math.min(...uv.map((p) => p[0])), umax = Math.max(...uv.map((p) => p[0])), vmin = Math.min(...uv.map((p) => p[1])), vmax = Math.max(...uv.map((p) => p[1]));
      const gapIn = (gs: number[], a: number, b: number) => { const xs = [a, ...gs.filter((x) => x > a && x < b), b].sort((x, y) => x - y); return Math.max(...xs.slice(1).map((x, i) => x - xs[i])); };
      best = Math.min(best, Math.min(gapIn(g.v, umin, umax), gapIn(g.u, vmin, vmax)));
    }
    const needs = up(best / (sd.continuous ?? 26) + 35, 25);
    return { id: sl.id, type: sl.type, level: sl.level, short_span_mm: r0(best), thickness_mm: struct, needs_mm: needs, ok: struct >= needs };
  });
  for (const c2 of slabChecks.filter((x) => !x.ok)) warnings.push(`slab ${c2.id} (${c2.level}) is ${c2.thickness_mm} mm; a ${c2.short_span_mm} mm span wants about ${c2.needs_mm} mm (span/${sd.continuous ?? 26} + cover)`);

  // ---- quantities (concrete m³; steel by rule-of-thumb ratios, kg/m³)
  const slabT = new Map(loads.slabs.map((sl) => [sl.level, slabChecks.find((x) => x.id === sl.id)?.thickness_mm ?? 0]));
  const qCol = colRows.reduce((a, k) => a + (k.size_mm[0] / 1000) * (k.size_mm[1] / 1000) * Math.max(0, k.height_mm + (k.bottom === ground ? found : 0)) / 1000, 0);
  const qBeam = beams.reduce((a, b) => a + (b.size_mm[0] / 1000) * (Math.max(0, b.size_mm[1] - (b.ground ? 0 : slabT.get(b.level) ?? 0)) / 1000) * (b.span_mm / 1000), 0);
  const qPad = pads.reduce((a, p) => a + (p.size_mm[0] / 1000) * (p.size_mm[1] / 1000) * (p.size_mm[2] / 1000), 0);
  const qSlab = loads.slabs.reduce((a, sl) => a + sl.area_m2 * (slabChecks.find((x) => x.id === sl.id)?.thickness_mm ?? 0) / 1000, 0);
  const steel = { slabs: 90, beams: 160, columns: 180, pads: 70 };
  const quantities = {
    concrete_m3: { columns: r2(qCol), beams_below_slab: r2(qBeam), pads: r2(qPad), slabs: r2(qSlab), total: r2(qCol + qBeam + qPad + qSlab) },
    steel_kg_estimate: r0(qCol * steel.columns + qBeam * steel.beams + qPad * steel.pads + qSlab * steel.slabs),
    steel_ratios_kg_m3: steel,
    excavation_m3: r2(pads.reduce((a, p) => a + ((p.size_mm[0] + 600) / 1000) ** 2 * (found / 1000), 0)),
  };

  // ---- the ops that build it in the structural model (levels, grids, pad-top level, columns, beams, pads)
  const hMax = Math.max(300, ...pads.map((p) => p.size_mm[2]));
  const padTopMm = -(found - hMax), padTop = `S Pad top ${(padTopMm / 1000).toFixed(2)}`;
  const used = new Set([...columns.flatMap((k) => [k.bottom, k.top]), ...beams.map((b) => b.level)]);
  const ops: any[] = [
    ...levels.filter((l) => used.has(l.name)).map((l) => ({ op: "level", name: l.name, elevation_mm: l.elevation_mm })),
    { op: "level", name: padTop, elevation_mm: padTopMm },
    ...grids.map((g) => ({ op: "grid", ...g })),
  ];
  const groups = new Map<string, { bottom: string; top: string; size: [number, number]; points: XY[]; rotation: number }>();
  for (const k of colRows) {
    const fr = columns.find((x) => x.id === k.id)!.fr;
    const bottom = k.bottom === ground ? padTop : k.bottom, key = `${bottom}|${k.top}|${k.size_mm.join("x")}|${fr.angle}`;
    const g = groups.get(key) ?? { bottom, top: k.top, size: k.size_mm, points: [], rotation: fr.angle }; g.points.push(k.at_mm); groups.set(key, g);
  }
  for (const g of groups.values()) ops.push({ op: "column", level: g.bottom, top_level: g.top, points_mm: g.points, size_mm: g.size, ...(g.rotation ? { rotation_deg: g.rotation } : {}) });
  for (const b of beams) ops.push({ op: "beam", level: b.level, start_mm: [...b.start, 0], end_mm: [...b.end, 0], size_mm: b.size_mm });
  const padGroups = new Map<string, { size: [number, number, number]; points: XY[] }>();
  for (const p of pads) { const key = p.size_mm.join("x"); const g = padGroups.get(key) ?? { size: p.size_mm, points: [] }; g.points.push(p.at_mm); padGroups.set(key, g); }
  for (const g of padGroups.values()) ops.push({ op: "isolated_foundation", level: padTop, points_mm: g.points, size_mm: g.size });

  return {
    status: "PRELIMINARY – NOT FOR CONSTRUCTION (no engineer of record)",
    basis: { max_span_mm: maxSpan, beam_depth: `span/${ratio}`, column: `N_uls / (0.4·${fck} + 0.67·${fy}·${rho})`, pad_bearing_kpa: qa, founding_depth_mm: found, grid_directions_deg: dirs },
    grids: { systems: frames.map((fr) => ({ prefix: fr.prefix || "(main)", angle_deg: fr.angle, lettered: gridAt.get(fr)!.u.length, numbered: gridAt.get(fr)!.v.length })), list: grids.map((g) => g.name) },
    columns: colRows,
    beams: { count: beams.length, ground: beams.filter((b) => b.ground).length, by_size: tally(beams.map((b) => b.size_mm.join("x"))), longest_mm: Math.max(0, ...beams.map((b) => b.span_mm)),
      list: beams.map((b) => ({ level: b.level, start_mm: b.start, end_mm: b.end, span_mm: b.span_mm, size_mm: b.size_mm, ground: b.ground })) },
    pads, slabs: slabChecks, quantities, loads: loads.totals, warnings, ops,
  };
}

function tally(xs: string[]): Record<string, number> {
  const t: Record<string, number> = {}; for (const x of xs) t[x] = (t[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(t).sort((a, b) => b[1] - a[1]));
}
