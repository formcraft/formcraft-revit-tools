/**
 * The workshop pack as a PDF the workshop reads (CW4, docs/PLAN_CASEWORK.md; board CW_Outputs). Pure: the engine's
 * own numbers drawn on A4 landscape pages, no Revit and no library.
 *
 *   1 Summary: counts, boards, the standards used, notes, kit change requests, and where Revit's shop-drawing sheets are
 *   2 Unit elevations: each unit's front, its doors or drawers, its sizes (scaled drawings, not Revit's sheets)
 *   3 Cut list per assembly mark
 *   4 Nesting: one page per sheet, every piece as a rectangle with its label, the kerf between cuts
 *   5 Hardware
 *   6 Cost with its sources: library prices only; "price needed" where the kit has none
 */
import { Casework, CostLine, Standards, Unit, costs } from "./casework.js";
import { A4_LANDSCAPE, MM, PdfDoc, PdfPage, fit, textWidth } from "./pdf.js";

const [PW, PH] = A4_LANDSCAPE;
const M = 36; // page margin, pt
const TOP = PH - M - 30; // first line under the page head

export interface PdfPackInput {
  code: string;
  label: string;
  casework: Casework;
  cost: ReturnType<typeof costs>;
  standards: Standards;
  /** Where the standards came from (the kit's file or the call) */
  standards_from: string;
  /** Revit's shop-drawing sheets (fmc_casework shop_drawings), when they have been exported beside the pack */
  shop_drawings?: string;
}

const num = (v: number) => v.toLocaleString("en-US");

/** A page with the pack's head; y runs down from TOP. */
class Writer {
  readonly doc: PdfDoc;
  page!: PdfPage;
  y = TOP;
  section = "";
  constructor(readonly head: string) { this.doc = new PdfDoc(head); }

  newPage(section = this.section) {
    this.section = section;
    this.page = this.doc.page(A4_LANDSCAPE);
    this.page.text(M, PH - M - 8, this.head, { size: 9, bold: true });
    this.page.text(PW - M, PH - M - 8, section, { size: 9, align: "right" });
    this.page.stroke(0, 0.5).line(M, PH - M - 14, PW - M, PH - M - 14);
    this.y = TOP;
  }

  /** Room for h more points on this page, or a new page of the same section. */
  need(h: number) { if (this.y - h < M + 20) this.newPage(); }

  heading(text: string) { this.need(24); this.page.text(M, this.y, text, { size: 13, bold: true }); this.y -= 20; }

  para(text: string, size = 9, gray = 0) {
    for (const line of wrap(text, size, PW - 2 * M)) { this.need(size + 4); this.page.text(M, this.y, line, { size, gray }); this.y -= size + 4; }
  }

  /** A table: column widths in pt; the header repeats on each new page. */
  table(cols: Array<{ title: string; width: number; align?: "left" | "right" }>, rows: Array<Array<string | number>>, o: { size?: number; bold?: (i: number) => boolean } = {}) {
    const size = o.size ?? 8, rh = size + 5;
    const head = () => {
      let x = M;
      this.page.rect(M, this.y - 3, cols.reduce((a, c) => a + c.width, 0), rh, 0.88);
      for (const c of cols) { this.cell(x, c, c.title, size, true); x += c.width; }
      this.y -= rh;
    };
    this.need(rh * 2);
    head();
    rows.forEach((r, i) => {
      if (this.y - rh < M + 20) { this.newPage(); head(); }
      let x = M;
      cols.forEach((c, j) => { this.cell(x, c, String(r[j] ?? ""), size, o.bold?.(i) ?? false); x += c.width; });
      this.page.stroke(0.8, 0.3).line(M, this.y - 3, M + cols.reduce((a, c) => a + c.width, 0), this.y - 3);
      this.y -= rh;
    });
    this.y -= 6;
  }

  private cell(x: number, c: { width: number; align?: "left" | "right" }, text: string, size: number, bold: boolean) {
    const t = fit(text, size, c.width - 6, bold);
    if (c.align === "right") this.page.text(x + c.width - 3, this.y, t, { size, bold, align: "right" });
    else this.page.text(x + 3, this.y, t, { size, bold });
  }
}

/** Words wrapped to a width. */
export function wrap(text: string, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) <= width || !line) line = next;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.map((l) => fit(l, size, width));
}

const kindName: Record<string, string> = { corner: "Corner", base: "Base", sink: "Sink", tall: "Tall", wall: "Wall" };
function frontsName(f: string): string {
  if (f === "door") return "door";
  if (f === "2door") return "2 doors";
  if (f === "none") return "open";
  const m = /^(\d)drawer$/.exec(f);
  return m ? `${m[1]} drawer${m[1] === "1" ? "" : "s"}` : f;
}

// ---------------------------------------------------------------------------------------------------------------

function summary(w: Writer, p: PdfPackInput) {
  const c = p.casework, s = p.standards;
  w.newPage("Summary");
  w.page.text(M, w.y, `${p.label} — workshop pack`, { size: 18, bold: true });
  w.y -= 26;
  w.para(`Project ${p.code}. Every number is the Casework engine's (fmc_casework). Sizes in mm. Standards from ${p.standards_from}.`, 9, 0.3);
  w.y -= 4;
  const units = c.layout.units.filter((u) => u.kind !== "gap");
  const pieces = c.parts.reduce((a, x) => a + x.qty, 0);
  const sheets = c.nests.reduce((a, n) => a + n.sheets.length, 0);
  w.table([{ title: "Units", width: 90 }, { title: "Part lines", width: 90 }, { title: "Pieces", width: 90 }, { title: "Sheets", width: 90 }, { title: "Edge banding", width: 110 }, { title: "Worktop", width: 110 }],
    [[units.length, c.parts.length, pieces, sheets, `${c.edge_m} m`, `${c.worktop_m} m`]], { size: 10 });
  w.heading("Boards");
  w.table([{ title: "Board (kit material)", width: 260 }, { title: "Sheets", width: 70, align: "right" }, { title: "Pieces", width: 70, align: "right" }, { title: "Yield", width: 70, align: "right" }],
    c.nests.map((n) => [n.material, n.sheets.length, n.parts, `${n.yield_pct} %`]));
  w.heading("Standards used");
  w.table([{ title: "Item", width: 160 }, { title: "Value", width: 450 }], [
    ["Sheet and kerf", `${s.sheet.length} × ${s.sheet.width}, kerf ${s.kerf}`],
    ["Carcass", `${s.carcass_board} (${s.carcass_thickness} mm)`],
    ["Fronts", s.front_board], ["Backs and drawer bottoms", s.back_board],
    ["Worktop", s.worktop ? `${s.worktop}, ${s.worktop_depth} deep` : `none named, ${s.worktop_depth} deep`],
    ["Base / wall / tall units", `${s.base.height} × ${s.base.depth} on ${s.plinth} legs / ${s.wall.height} × ${s.wall.depth} / ${s.tall.height} × ${s.tall.depth}`],
  ]);
  w.heading("Shop drawings");
  w.para(p.shop_drawings
    ? `Revit's shop-drawing sheets (A3, from the model): ${p.shop_drawings}, in the same folder. The unit elevations in this pack are drawn from the engine.`
    : "Revit's shop-drawing sheets aren't made yet: they come from the model (fmc_casework shop_drawings, CW2). The unit elevations in this pack are drawn from the engine.");
  const notes = [...c.layout.notes, ...c.problems.map((x) => `Problem: ${x}`)];
  if (notes.length) { w.heading("Notes"); for (const n of notes) w.para(`• ${n}`); }
  if (p.cost.kit_requests.length) { w.heading("Kit change requests"); for (const k of p.cost.kit_requests) w.para(`• ${k.item}: ${k.request} (${k.why})`); }
}

/** Each unit's front: the carcass, legs, doors or drawers, its width and height; scale 1:25 on the page. */
function elevations(w: Writer, p: PdfPackInput) {
  const s = p.standards, c = s.construction;
  const scale = 25, k = MM / scale; // pt per mm
  const units = p.casework.layout.units.filter((u) => u.kind !== "gap");
  w.newPage("Unit elevations");
  w.para(`Front elevations at 1:${scale} on A4. Fronts are drawn ${c.front_gap} mm smaller than the carcass; drawer heights from the standards or the unit.`, 9, 0.3);
  w.y -= 6;
  let x = M, rowH = 0;
  const gap = 28;
  for (const u of units) {
    const box = u.kind === "wall" ? s.wall : u.kind === "tall" ? s.tall : s.base;
    const legs = u.kind === "wall" ? 0 : s.plinth;
    const wpt = u.width * k, hpt = (box.height + legs) * k;
    const need = hpt + 40;
    if (x > M && x + wpt + 30 > PW - M) { x = M; w.y -= rowH + gap; rowH = 0; }
    if (w.y - need < M + 20) { w.newPage(); x = M; rowH = 0; }
    drawUnit(w.page, u, x + 18, w.y - 14 - hpt, k, box.height, legs, s);
    w.page.text(x + 18, w.y - 8, `${u.mark}  ${kindName[u.kind] ?? u.kind} ${u.width}, ${frontsName(u.fronts)}`, { size: 8, bold: true });
    x += wpt + 18 + gap;
    rowH = Math.max(rowH, need);
  }
  w.y -= rowH + gap;
}

function drawUnit(pg: PdfPage, u: Unit, x: number, y: number, k: number, H: number, legs: number, s: Standards) {
  const W = u.width, c = s.construction, g = c.front_gap;
  const by = y + legs * k;
  if (legs) { pg.stroke(0.4, 0.4).rect(x + 2, y, W * k - 4, legs * k, 0.93); }
  pg.stroke(0, 0.8).rect(x, by, W * k, H * k);
  const front = (fx: number, fy: number, fw: number, fh: number) => pg.stroke(0.2, 0.5).rect(x + fx * k, by + fy * k, fw * k, fh * k, 0.97);
  if (u.fronts === "door") {
    const dw = u.kind === "corner" ? c.corner_door : W - g;
    front(u.kind === "corner" ? W - dw - g / 2 : g / 2, g / 2, dw, H - g);
    if (u.kind === "corner") pg.text(x + ((W - dw) / 2) * k, by + (H / 2) * k, "blind", { size: 6, align: "center", gray: 0.4 });
  } else if (u.fronts === "2door") {
    const dw = W / 2 - g;
    front(g / 2, g / 2, dw, H - g);
    front(W / 2 + g / 2, g / 2, dw, H - g);
  } else if (/drawer$/.test(u.fronts)) {
    const n = Number(u.fronts[0]);
    const hs = u.drawer_heights ?? c.drawer.heights[String(n)] ?? [];
    let top = H;
    for (const h of hs) { front(g / 2, top - h + g / 2, W - g, h - g); top -= h; }
  }
  // sizes: width under, height on the left
  pg.stroke(0.3, 0.3).line(x, y - 6, x + W * k, y - 6);
  pg.text(x + (W * k) / 2, y - 14, String(W), { size: 7, align: "center" });
  pg.textUp(x - 4, by + (H * k) / 2 - 6, String(H), { size: 7 });
}

function cutList(w: Writer, p: PdfPackInput) {
  w.newPage("Cut list");
  w.para("Per assembly mark. Length × width in mm, finished sizes; edge = the banded edges of each piece.", 9, 0.3);
  const cols = [{ title: "Part", width: 150 }, { title: "Length", width: 60, align: "right" as const }, { title: "Width", width: 60, align: "right" as const },
    { title: "Qty", width: 40, align: "right" as const }, { title: "Board", width: 230 }, { title: "Edge", width: 110 }, { title: "Edge m", width: 60, align: "right" as const }];
  const marks = [...new Set(p.casework.cutlist.map((r) => r.mark))];
  for (const mark of marks) {
    const u = p.casework.layout.units.find((x) => x.mark === mark);
    const rows = p.casework.cutlist.filter((r) => r.mark === mark);
    w.need(60);
    w.page.text(M, w.y, `${mark}${u ? `  ${kindName[u.kind] ?? u.kind} ${u.width}, ${frontsName(u.fronts)}, wall ${u.wall || "—"}` : ""}`, { size: 10, bold: true });
    w.y -= 14;
    w.table(cols, rows.map((r) => [r.part, r.length, r.width, r.qty, r.board, r.edge, r.edge_m]));
  }
}

function nesting(w: Writer, p: PdfPackInput) {
  const s = p.standards;
  const SL = Math.max(s.sheet.length, s.sheet.width), SW = Math.min(s.sheet.length, s.sheet.width);
  const k = Math.min((PW - 2 * M) / SL, (TOP - M - 60) / SW);
  for (const n of p.casework.nests) {
    for (const sh of n.sheets) {
      w.newPage("Nesting");
      w.page.text(M, w.y, `${n.material} — sheet ${sh.index} of ${n.sheets.length}`, { size: 12, bold: true });
      w.page.text(PW - M, w.y, `${SL} × ${SW}, kerf ${s.kerf}, ${sh.items.length} pieces, yield ${sh.yield_pct} %`, { size: 9, align: "right" });
      const x0 = M, y0 = w.y - 16 - SW * k;
      w.page.stroke(0, 1).rect(x0, y0, SL * k, SW * k);
      for (const it of sh.items) {
        // the sheet's y runs down from its top edge, as the saw reads it
        const px = x0 + it.x * k, py = y0 + (SW - it.y - it.w) * k, pw = it.l * k, ph = it.w * k;
        w.page.stroke(0.25, 0.4).rect(px, py, pw, ph, 0.94);
        const size = Math.max(4, Math.min(7, ph / 3));
        if (ph > size * 2.4) {
          w.page.text(px + pw / 2, py + ph / 2 + 1, fit(it.label, size, pw - 4), { size, align: "center" });
          w.page.text(px + pw / 2, py + ph / 2 - size, fit(`${it.l} × ${it.w}`, size - 1, pw - 4), { size: size - 1, align: "center", gray: 0.35 });
        } else if (ph > size + 2) w.page.text(px + pw / 2, py + (ph - size) / 2 + 1, fit(`${it.label} ${it.l}×${it.w}`, size, pw - 4), { size, align: "center" });
      }
      w.y = y0 - 16;
      w.page.text(M, w.y, "Rows run across the sheet from the top-left corner; the kerf sits between every cut. Plain boards: pieces are turned freely (no grain).", { size: 8, gray: 0.35 });
    }
    if (n.too_big.length) { w.newPage("Nesting"); w.heading(`${n.material}: too big for a sheet`); for (const t of n.too_big) w.para(`• ${t}`); }
  }
}

function hardwareAndCost(w: Writer, p: PdfPackInput) {
  w.newPage("Hardware and cost");
  w.heading("Hardware");
  w.table([{ title: "Item", width: 300 }, { title: "Qty", width: 80, align: "right" }, { title: "Unit", width: 60 }],
    p.casework.hardware.map((h) => [h.item, h.qty, h.unit]));
  w.heading("Cost");
  const t = p.cost.total;
  w.para(t.priced
    ? `Priced from the kit's material library: UGX ${num(t.ugx_low)}${t.ugx_high !== t.ugx_low ? `–${num(t.ugx_high)}` : ""} for ${t.priced} of ${p.cost.lines.length} lines. The other ${t.price_needed} say "price needed": a missing price is flagged, never guessed.`
    : `Nothing is priced: the kit's material library has no usable price for these ${p.cost.lines.length} lines ("price needed"; never guessed).`);
  w.table([{ title: "Item", width: 140 }, { title: "Material", width: 165 }, { title: "Qty", width: 50, align: "right" }, { title: "Price", width: 185 },
    { title: "Status", width: 55 }, { title: "Source", width: 135 }, { title: "Date", width: 40 }],
  p.cost.lines.map((l: CostLine) => [l.item, l.material || "—", `${l.quantity} ${l.unit}`, l.price, l.status, l.source, l.date]), { size: 7 });
}

/** The workshop pack PDF; the same input always gives the same bytes. */
export function workshopPackPdf(p: PdfPackInput): Buffer {
  const w = new Writer(`${p.code} · Casework · ${p.label}`);
  summary(w, p);
  elevations(w, p);
  cutList(w, p);
  nesting(w, p);
  hardwareAndCost(w, p);
  const total = w.doc.pages.length;
  w.doc.pages.forEach((pg, i) => pg.text(PW - M, M - 14, `Page ${i + 1} of ${total}`, { size: 8, align: "right", gray: 0.35 })
    .text(M, M - 14, "Formcraft Casework Assistant — the engine's numbers; check on site before cutting", { size: 8, gray: 0.35 }));
  return w.doc.bytes();
}

