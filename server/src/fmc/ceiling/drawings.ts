/**
 * Ceiling drawings (Engineer › Ceilings, step CL4, docs/PLAN_CEILINGS.md). Pure: what fmc_ceiling_sheet draws.
 *  - The board set-out drawing as a drafting view: numbered boards, zone edges, main channels, furring, hangers and
 *    setting-out points, in paper mm (the same item format as the line diagrams' drafting views: line, text, symbol).
 *  - A schematic section through the room each way from the design's heights (structure, each ceiling, the steps).
 *  - The reflected ceiling plan's annotation: the kit's FMC_SYM_* symbols at the fixture marks, a ceiling-height
 *    symbol and text in each ceiling part, a level-change symbol on each step, and a key, in model mm.
 *  - The RCP sheet from the kit's sheet register (the row placed with VT_I_RCP).
 * Symbols are only named when the kit's family register lists them; the rest are kit change requests (rule 7).
 */
import { Pt, Rect, bbox } from "./geometry.js";
import { CeilingInput, Design, Evaluated } from "./engine.js";
import { MarkKind, PlacePlan, regionComponents, steps } from "./place.js";

const EPS = 1e-6;
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface DrawStyles { thin: string; medium: string; wide: string; text: string; title: string; text_mm: number; title_mm: number }
/** The kit's drafting styles, as the line diagrams use them (FMC_Thin/Medium/Wide, FMC_Arial_*). */
export const CEILING_STYLES: DrawStyles = { thin: "FMC_Thin", medium: "FMC_Medium", wide: "FMC_Wide", text: "FMC_Arial_2.5", title: "FMC_Arial_3.5_Bold", text_mm: 2.5, title_mm: 3.5 };

export type DrawItem =
  | { t: "line"; points: number[][]; style: string; source_id: string }
  | { t: "text"; at: number[]; text: string; style: string; align: "left" | "center" | "right"; source_id: string; rotation_deg: number }
  | { t: "symbol"; family: string; type: string; at: number[]; rotation_deg: number; source_id: string; params: Record<string, string> };
export interface DrawView { name: string; kind: "ceiling"; scale: number; sheet_hint: string | null; items: DrawItem[] }

const P = (scale: number, p: Pt): number[] => [r2(p[0] / scale), r2(p[1] / scale)];
const rect = (r: Rect): Pt[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1], [r.x0, r.y0]];

// ---------- the set-out drawing ----------

/**
 * The board set-out as a drafting view: paper mm at 1:scale, the room's corner at (0, 0). Every item has a stable
 * source id, so a second run redraws only what it drew and keeps a person's notes.
 */
export function setoutView(e: Evaluated, input: CeilingInput, name: string, scale = 50, s: DrawStyles = CEILING_STYLES, sheetHint: string | null = null): DrawView {
  const d = e.design, so = e.setout;
  const items: DrawItem[] = [];
  const line = (id: string, pts: Pt[], style: string) => items.push({ t: "line", points: pts.map((p) => P(scale, p)), style, source_id: id });
  const text = (id: string, p: Pt, t: string, style = s.text, align: "left" | "center" | "right" = "left") =>
    items.push({ t: "text", at: P(scale, p), text: t, style, align, source_id: id, rotation_deg: 0 });
  const bb = bbox(d.room);
  const th = s.text_mm * scale; // a text's height in model mm

  // the room outline (each wall run) and the steps between ceilings
  outlineRuns(d.room).forEach((r, i) => line(`room:${i + 1}`, [r.a, r.b], s.wide));
  steps(d).forEach((st, i) => line(`step:${i + 1}`, [st.a, st.b], s.medium));

  // boards: each sheet (or each piece of a sheet cut round a notch), its number in the middle
  for (const z of so.zones) {
    for (const b of z.boards) {
      const shapes: Rect[] = b.pieces.length ? b.pieces : [{ x0: b.x_mm, y0: b.y_mm, x1: b.x_mm + b.width_mm, y1: b.y_mm + b.depth_mm }];
      shapes.forEach((r, k) => line(`board:${b.id}:${k + 1}`, rect(r), s.thin));
      const big = shapes.reduce((m, r) => ((r.x1 - r.x0) * (r.y1 - r.y0) > (m.x1 - m.x0) * (m.y1 - m.y0) ? r : m), shapes[0]);
      if (big.x1 - big.x0 > 2 * th && big.y1 - big.y0 > 1.5 * th)
        text(`board-label:${b.id}`, [(big.x0 + big.x1) / 2, (big.y0 + big.y1) / 2 + th / 2], b.id + (b.cut ? "*" : ""), s.text, "center");
    }
    // setting-out points: a cross in a square, and its name
    z.setting_out_points.forEach((p, i) => {
      const k = 0.75 * th;
      line(`sop:${z.zone}:${i + 1}:a`, [[p[0] - k, p[1] - k], [p[0] + k, p[1] + k]], s.medium);
      line(`sop:${z.zone}:${i + 1}:b`, [[p[0] - k, p[1] + k], [p[0] + k, p[1] - k]], s.medium);
      line(`sop:${z.zone}:${i + 1}:c`, rect({ x0: p[0] - k, y0: p[1] - k, x1: p[0] + k, y1: p[1] + k }), s.thin);
      text(`sop-label:${z.zone}:${i + 1}`, [p[0] + 1.2 * k, p[1] - 1.2 * k], `${z.zone}-SOP${i + 1} (+${z.height_mm})`);
    });
  }
  // main channels (labelled), furring and hangers
  so.mains.forEach((m, i) => {
    line(`main:${i + 1}`, [[m.from, m.y], [m.to, m.y]], s.medium);
    text(`main-label:${i + 1}`, [m.to + 0.5 * th, m.y + th / 2], `M${i + 1}`);
  });
  so.furring.forEach((f, i) => line(`furring:${i + 1}`, [[f.x, f.from], [f.x, f.to]], s.thin));
  const hk = 0.4 * th;
  so.hangers.forEach((h, i) => {
    line(`hanger:${i + 1}:a`, [[h[0] - hk, h[1]], [h[0] + hk, h[1]]], s.medium);
    line(`hanger:${i + 1}:b`, [[h[0], h[1] - hk], [h[0], h[1] + hk]], s.medium);
  });

  // title and notes under the plan
  const below = bb.y0 - 3 * th;
  text("title", [bb.x0, below], `${input.room.name}: board set-out, ${d.label} (1:${scale})`, s.title);
  const zonesLine = so.zones.map((z) => `${z.zone} +${z.height_mm}: ${z.boards.length} boards`).join("; ");
  text("notes", [bb.x0, below - 2 * th], [
    `Sheets ${so.sheet}. ${zonesLine}.`,
    `Boards numbered F field, B bulkhead, R raft, C coffer; * cut to shape. Rows run from each setting-out point (SOP).`,
    `M main channels (labelled), thin lines furring, crosses hangers (${so.hangers.length}). Faces between ceilings: ${so.faces.length} runs.`,
    `Set-out values the kit doesn't hold yet are reference values (kit change requests in the tool's answer).`,
  ].join("\n"));
  return { name, kind: "ceiling", scale, sheet_hint: sheetHint, items };
}

/** The room's outline as wall runs (each rectangle edge that isn't shared with another rectangle of the room). */
export function outlineRuns(rs: Rect[]): Array<{ a: Pt; b: Pt }> {
  const xs = [...new Set(rs.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rs.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const inside = (x: number, y: number) => rs.some((r) => x > r.x0 + EPS && x < r.x1 - EPS && y > r.y0 + EPS && y < r.y1 - EPS);
  const segs: Array<{ a: Pt; b: Pt }> = [];
  for (let i = 0; i + 1 < xs.length; i++) for (const y of ys) {
    const mx = (xs[i] + xs[i + 1]) / 2;
    if (inside(mx, y - 0.5) !== inside(mx, y + 0.5)) segs.push({ a: [xs[i], y], b: [xs[i + 1], y] });
  }
  for (let j = 0; j + 1 < ys.length; j++) for (const x of xs) {
    const my = (ys[j] + ys[j + 1]) / 2;
    if (inside(x - 0.5, my) !== inside(x + 0.5, my)) segs.push({ a: [x, ys[j]], b: [x, ys[j + 1]] });
  }
  // join collinear runs
  const out: Array<{ a: Pt; b: Pt }> = [];
  for (const sg of segs) {
    const prev = out.find((o) => (Math.abs(o.a[1] - o.b[1]) < EPS && Math.abs(sg.a[1] - sg.b[1]) < EPS && Math.abs(o.a[1] - sg.a[1]) < EPS && Math.abs(o.b[0] - sg.a[0]) < EPS)
      || (Math.abs(o.a[0] - o.b[0]) < EPS && Math.abs(sg.a[0] - sg.b[0]) < EPS && Math.abs(o.a[0] - sg.a[0]) < EPS && Math.abs(o.b[1] - sg.a[1]) < EPS));
    if (prev) prev.b = sg.b; else out.push({ a: sg.a, b: sg.b });
  }
  return out;
}

// ---------- the section ----------

export interface ProfileRun { from: number; to: number; height_mm: number; zone: string }

/**
 * The ceiling heights along a cut: axis "x" cuts along the width at y = at, "y" along the depth at x = at. A cut that
 * falls on an edge moves 1 mm so it reads one ceiling, not two.
 */
export function sectionProfile(d: Design, axis: "x" | "y", at: number): ProfileRun[] {
  const all = d.zones.flatMap((z) => z.rects);
  let c = at;
  while (all.some((r) => Math.abs((axis === "x" ? r.y0 : r.x0) - c) < EPS || Math.abs((axis === "x" ? r.y1 : r.x1) - c) < EPS)) c += 1;
  const runs: ProfileRun[] = [];
  for (const z of d.zones) for (const r of z.rects) {
    const [lo, hi, a0, a1] = axis === "x" ? [r.y0, r.y1, r.x0, r.x1] : [r.x0, r.x1, r.y0, r.y1];
    if (c > lo && c < hi) runs.push({ from: a0, to: a1, height_mm: z.height, zone: z.id });
  }
  runs.sort((p, q) => p.from - q.from);
  const out: ProfileRun[] = [];
  for (const r of runs) {
    const l = out[out.length - 1];
    if (l && l.zone === r.zone && Math.abs(l.to - r.from) < EPS) l.to = r.to; else out.push({ ...r });
  }
  return out;
}

/** Two schematic sections (along the width and along the depth, through the room's middle), from the design's heights. */
export function sectionView(d: Design, input: CeilingInput, name: string, scale = 50, s: DrawStyles = CEILING_STYLES, sheetHint: string | null = null): DrawView {
  const items: DrawItem[] = [];
  const bb = bbox(d.room);
  const H = input.room.structure_height_mm;
  const th = s.text_mm * scale;
  const line = (id: string, pts: Pt[], style: string) => items.push({ t: "line", points: pts.map((p) => P(scale, p)), style, source_id: id });
  const text = (id: string, p: Pt, t: string, style = s.text, align: "left" | "center" | "right" = "left") =>
    items.push({ t: "text", at: P(scale, p), text: t, style, align, source_id: id, rotation_deg: 0 });
  const cuts: Array<{ axis: "x" | "y"; at: number; label: string }> = [
    { axis: "x", at: (bb.y0 + bb.y1) / 2, label: "A-A along the width" },
    { axis: "y", at: (bb.x0 + bb.x1) / 2, label: "B-B along the depth" },
  ];
  let base = 0;
  for (const [k, cut] of cuts.entries()) {
    const prof = sectionProfile(d, cut.axis, cut.at);
    if (!prof.length) continue;
    const id = `sec${k + 1}`;
    const x0 = prof[0].from, x1 = prof[prof.length - 1].to;
    // floor, structure (ties or slab) and the ceiling profile with its steps
    line(`${id}:floor`, [[x0, base], [x1, base]], s.medium);
    line(`${id}:structure`, [[x0, base + H], [x1, base + H]], s.thin);
    text(`${id}:structure-label`, [x1 + 0.5 * th, base + H + th / 2], `${input.room.structure === "slab" ? "Slab soffit" : "Underside of ties"} +${H}`);
    const pts: Pt[] = [];
    for (const r of prof) { pts.push([r.from, base + r.height_mm], [r.to, base + r.height_mm]); }
    line(`${id}:ceiling`, pts, s.wide);
    line(`${id}:wall-a`, [[x0, base], [x0, base + H]], s.medium);
    line(`${id}:wall-b`, [[x1, base], [x1, base + H]], s.medium);
    prof.forEach((r, i) => {
      if (r.to - r.from > 3 * th) text(`${id}:h${i + 1}`, [(r.from + r.to) / 2, base + r.height_mm - 0.4 * th], `+${r.height_mm} ${r.zone}\nvoid ${H - r.height_mm}`, s.text, "center");
    });
    text(`${id}:title`, [x0, base - 1.5 * th], `Section ${cut.label} (${cut.axis === "x" ? "y" : "x"} = ${Math.round(cut.at)}), 1:${scale}`, s.title);
    base -= H + 8 * th;
  }
  text("note", [bb.x0, base + 4 * th], [
    "Schematic: heights from the ceiling design (floor, structure, each ceiling and its steps).",
    "Bulkhead, cove, cornice and hatch construction details need the kit's ceiling detail items (kit change request).",
  ].join("\n"));
  return { name, kind: "ceiling", scale, sheet_hint: sheetHint, items };
}

// ---------- the reflected ceiling plan ----------

/**
 * The kit symbols the RCP uses, by what they mark. Each must be listed in the kit's family register
 * (03_Master_Data\FMC_Family_Register.csv, type "Standard"); the RCP leaves out any that isn't and reports it.
 */
export const RCP_SYMBOLS: Record<MarkKind | "detector_heat" | "height" | "level_change", string> = {
  fan: "FMC_SYM_E_CeilingFan",
  downlight: "FMC_SYM_E_Downlight",
  detector: "FMC_SYM_E_SmokeDetector",
  detector_heat: "FMC_SYM_E_HeatDetector",
  ac_grille: "FMC_SYM_M_SupplyDiffuser",
  hatch: "FMC_SYM_I_CeilingAccessPanel",
  sprinkler: "FMC_SYM_FP_SprinklerHeadPendent",
  height: "FMC_SYM_I_CeilingHeightTag",
  level_change: "FMC_SYM_I_BulkheadCeilingLevelChange",
};

export interface RcpSymbol { key: string; family: string; type: string; at: Pt; label: string }
export interface RcpText { key: string; at: Pt; text: string; style: string }
export interface RcpSpec { symbols: RcpSymbol[]; texts: RcpText[]; crop_mm: [number, number, number, number]; kit_change_requests: string[]; left_out: string[] }

/**
 * The RCP's annotation in model mm. register: the family names in the kit's family register (null when it couldn't be
 * read: then every symbol is sent and Revit reports what isn't loaded).
 */
export function rcpSpec(d: Design, plan: PlacePlan, input: CeilingInput, origin: { x: number; y: number }, register: Set<string> | null, s: DrawStyles = CEILING_STYLES, scale = 50): RcpSpec {
  const symbols: RcpSymbol[] = [];
  const texts: RcpText[] = [];
  const kcr: string[] = [];
  const leftOut: string[] = [];
  const known = (fam: string) => register === null || register.has(fam);
  const used = new Set<string>();
  const sym = (key: string, fam: string, p: Pt, label: string) => {
    if (!known(fam)) { if (!leftOut.includes(fam)) leftOut.push(fam); return false; }
    symbols.push({ key, family: fam, type: "Standard", at: p, label });
    used.add(fam);
    return true;
  };
  const th = s.text_mm * scale;
  for (const m of plan.marks) {
    const fam = m.kind === "detector" && /heat/i.test(m.label) ? RCP_SYMBOLS.detector_heat : RCP_SYMBOLS[m.kind];
    sym(`rcp:${m.key}`, fam, [m.x, m.y], m.label);
  }
  // a height symbol and its text in each ceiling part, at the middle of its biggest rectangle
  for (const z of d.zones) regionComponents(z.rects).forEach((part, i) => {
    const big = part.reduce((a, r) => ((r.x1 - r.x0) * (r.y1 - r.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? r : a), part[0]);
    let p: Pt = [origin.x + (big.x0 + big.x1) / 2, origin.y + (big.y0 + big.y1) / 2];
    // keep it off a fixture mark in the same spot
    if (plan.marks.some((m) => Math.hypot(m.x - p[0], m.y - p[1]) < 2 * th)) p = [p[0], p[1] - 3 * th];
    sym(`rcp:height:${z.id}:${i + 1}`, RCP_SYMBOLS.height, p, `${z.id} +${z.height}`);
    texts.push({ key: `rcp:height-text:${z.id}:${i + 1}`, at: [p[0] + th, p[1] + th / 2], text: `+${z.height}`, style: s.text });
  });
  steps(d).forEach((st, i) => sym(`rcp:step:${i + 1}`, RCP_SYMBOLS.level_change, [origin.x + (st.a[0] + st.b[0]) / 2, origin.y + (st.a[1] + st.b[1]) / 2], `step ${st.top_mm - st.bottom_mm}`));
  for (const f of leftOut) kcr.push(`${f} isn't in the kit's family register (03_Master_Data\\FMC_Family_Register.csv): the RCP leaves it out`);

  const bb = bbox(d.room);
  const keyAt: Pt = [origin.x + bb.x0, origin.y + bb.y0 - 2 * th];
  const heights = [...new Set(d.zones.map((z) => z.height))].sort((a, b) => b - a);
  texts.push({ key: "rcp:key", at: keyAt, style: s.text, text: [
    `${input.room.name}: reflected ceiling plan, ${d.label}. Heights above the floor: ${heights.map((h) => `+${h}`).join(", ")}.`,
    `Symbols: ${[...used].join(", ") || "none loaded"}.`,
    "Light, fan, detector and sprinkler marks are positions only: the electrical and fire engineers design them.",
  ].join("\n") });
  const m = 6 * th;
  const crop: [number, number, number, number] = [origin.x + bb.x0 - m, origin.y + bb.y0 - 2 * m, origin.x + bb.x1 + m, origin.y + bb.y1 + m];
  return { symbols, texts, crop_mm: crop, kit_change_requests: kcr, left_out: leftOut };
}

// ---------- the kit's registers ----------

/** A small CSV reader (quoted fields, doubled quotes, CRLF): rows of strings. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.length)) rows.push(row);
  return rows;
}

/** Family names in the kit's family register (column "Family"). */
export function registerFamilies(csv: string): Set<string> {
  const rows = parseCsv(csv);
  const i = (rows[0] ?? []).findIndex((h) => h.trim().toLowerCase() === "family");
  return new Set(i < 0 ? [] : rows.slice(1).map((r) => (r[i] ?? "").trim()).filter(Boolean));
}

/** The interiors RCP sheet in the kit's sheet register: the row placed with the view template, else null. */
export function rcpSheet(csv: string, template = "VT_I_RCP"): { number: string; name: string; scale: string } | null {
  const rows = parseCsv(csv);
  const h = (rows[0] ?? []).map((x) => x.trim().toLowerCase());
  const [n, nm, sc, pl] = ["sheetnumber", "sheetname", "scale", "placed"].map((k) => h.indexOf(k));
  if (n < 0 || pl < 0) return null;
  const row = rows.slice(1).find((r) => (r[pl] ?? "").split(/[;,]/).map((x) => x.trim()).includes(template));
  return row ? { number: row[n].trim(), name: (row[nm] ?? "").trim(), scale: (row[sc] ?? "").trim() } : null;
}
