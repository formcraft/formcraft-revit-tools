import { DrawItem, DrawView } from "./contract.js";
import { DEFAULT_DIAGRAM_KIT, DiagramKit, Mark, Value, symbolSize } from "./symbols.js";

/**
 * Line diagrams: the drawing canvas (paper mm, y up), text measuring, the TBC collector, the frame (title, legend,
 * notes) and the collision check. Pure: no Revit, no files.
 */

export type Align = "left" | "center" | "right";
export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Two decimals: stable JSON, no float noise. */
export const r2 = (n: number) => Math.round(n * 100) / 100;

export function textHeight(style: string, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): number {
  const h = kit.styles.text_height_mm[style];
  if (typeof h === "number" && h > 0) return h;
  const m = /(\d+(?:\.\d+)?)/.exec(style);
  return m ? Number(m[1]) : 2.5;
}

/** Conservative text size: the longest line × char width, lines × pitch (1.3 × height for the first: descenders). */
export function textSize(text: string, style: string, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): { w: number; h: number } {
  const th = textHeight(style, kit);
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => [...l].length));
  return { w: longest * th * kit.styles.char_width, h: th * (1.3 + (lines.length - 1) * kit.styles.line_pitch) };
}

/** Box of a text item: unrotated from its top anchor at the alignment side, then turned about the anchor. */
export function textBox(at: number[], text: string, style: string, align: Align, rotation: number, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): Box {
  const { w, h } = textSize(text, style, kit);
  const [ax, ay] = at;
  const dx0 = align === "left" ? 0 : align === "center" ? -w / 2 : -w;
  const corners = [[dx0, 0], [dx0 + w, 0], [dx0, -h], [dx0 + w, -h]];
  const t = (rotation * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const xs = corners.map(([x, y]) => ax + x * c - y * s), ys = corners.map(([x, y]) => ay + x * s + y * c);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function symbolBox(at: number[], family: string, type: string, rotation: number, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): Box {
  const [w, h] = symbolSize(family, type, kit);
  const turned = Math.round(((rotation % 180) + 180) % 180) === 90;
  const [bw, bh] = turned ? [h, w] : [w, h];
  return { x0: at[0] - bw / 2, y0: at[1] - bh / 2, x1: at[0] + bw / 2, y1: at[1] + bh / 2 };
}

// ---------------------------------------------------------------------------------------------------------------
// TBC: every value the model doesn't hold prints TBC and is listed in the view's notes.

export class Tbc {
  private entries = new Map<string, { subject: string; field: string; count: number }>();
  /** The value as text, or `label` (default "TBC") when the model has none; the gap is recorded. */
  value(v: Value | undefined, subject: string, field: string, unit = "", label = "TBC"): string {
    if (v === null || v === undefined || String(v).trim() === "") { this.add(subject, field); return label; }
    return typeof v === "number" && unit ? `${v} ${unit}` : String(v).trim();
  }
  add(subject: string, field: string, count = 1) {
    const k = `${subject}\u0000${field}`;
    const e = this.entries.get(k);
    if (e) e.count += count; else this.entries.set(k, { subject, field, count });
  }
  get size() { return this.entries.size; }
  lines(): string[] {
    return [...this.entries.values()].map((e) => `${e.subject}: ${e.field} TBC${e.count > 1 ? ` (×${e.count})` : ""}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The canvas

export interface LegendEntry { key: string; label: string; family: string | null; type: string | null }

export class Canvas {
  items: DrawItem[] = [];
  legend = new Map<string, LegendEntry>();
  tbc = new Tbc();
  notes: string[] = [];
  warnings: string[] = [];
  /** Scan ids this view shows without an item of their own: a load in a way label, a counted device, a note. */
  covered = new Set<string>();
  constructor(public kit: DiagramKit = DEFAULT_DIAGRAM_KIT) {}

  get grid() { return this.kit.styles.grid_mm; }
  snap(v: number) { return r2(Math.round(v / this.grid) * this.grid); }
  up(v: number) { return r2(Math.ceil(v / this.grid - 1e-9) * this.grid); }
  down(v: number) { return r2(Math.floor(v / this.grid + 1e-9) * this.grid); }
  get label() { return this.kit.styles.text.label; }
  get title() { return this.kit.styles.text.title; }
  get lines() { return this.kit.styles.lines; }
  th(style = this.label) { return textHeight(style, this.kit); }
  measure(text: string, style = this.label) { return textSize(text, style, this.kit); }
  /** Height of an n-line block in the label style. */
  blockH(n: number, style = this.label) { const t = this.th(style); return t * (1.3 + (n - 1) * this.kit.styles.line_pitch); }

  symbol(family: string, type: string, x: number, y: number, source: string | null, label: string, rotation = 0) {
    this.items.push({ t: "symbol", family, type, at: [r2(x), r2(y)], rotation_deg: rotation, source_id: source, params: {} });
    const key = `${family}:${type}`;
    if (!this.legend.has(key)) this.legend.set(key, { key, label, family, type });
  }

  line(points: number[][], style: string, source: string | null = null) {
    const pts = points.map(([x, y]) => [r2(x), r2(y)]).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    if (pts.length < 2) return;
    this.items.push({ t: "line", points: pts, style, source_id: source });
  }

  text(x: number, y: number, text: string, opts: { style?: string; align?: Align; source?: string | null; rotation?: number } = {}) {
    this.items.push({ t: "text", at: [r2(x), r2(y)], text, style: opts.style ?? this.label, align: opts.align ?? "left",
      source_id: opts.source ?? null, rotation_deg: opts.rotation ?? 0 });
  }

  /** The plain box for a node with no kit symbol: four lines, centred on (x, y). */
  box(x: number, y: number, source: string | null) {
    const [w, h] = this.kit.box;
    this.line([[x - w / 2, y - h / 2], [x + w / 2, y - h / 2], [x + w / 2, y + h / 2], [x - w / 2, y + h / 2], [x - w / 2, y - h / 2]], this.lines.thin, source);
    if (!this.legend.has("box")) this.legend.set("box", { key: "box", label: "No kit symbol yet: see the warnings", family: null, type: null });
  }

  /** Size [w, h] of what a mark draws. */
  markSize(m: Mark): [number, number] {
    if (m.t === "symbol") return symbolSize(m.family, m.type, this.kit);
    if (m.t === "box") return [this.kit.box[0], this.kit.box[1]];
    return [0, 0];
  }

  /** Draws a mark centred on (x, y); a box also records its warning once. */
  mark(m: Mark, x: number, y: number, source: string | null) {
    if (m.t === "symbol") this.symbol(m.family, m.type, x, y, source, m.label);
    else if (m.t === "box") { this.box(x, y, source); this.warn(m.reason); }
  }

  warn(w: string) { if (!this.warnings.includes(w)) this.warnings.push(w); }
  note(n: string) { if (!this.notes.includes(n)) this.notes.push(n); }

  /** Bounding box of everything drawn so far. */
  extent(): Box | null {
    const boxes = this.items.map((i) => itemBox(i, this.kit) ?? lineBox(i));
    const b = boxes.filter((x): x is Box => !!x);
    if (!b.length) return null;
    return { x0: Math.min(...b.map((x) => x.x0)), y0: Math.min(...b.map((x) => x.y0)), x1: Math.max(...b.map((x) => x.x1)), y1: Math.max(...b.map((x) => x.y1)) };
  }

  /**
   * The frame: title and subtitle above, the legend of the symbols used to the right, and the notes (every TBC value,
   * then the diagram's own notes) under the legend.
   */
  frame(title: string, subtitle: string) {
    const e = this.extent() ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    const x0 = this.down(e.x0), top = this.up(e.y1);
    this.text(x0, top + 20, title, { style: this.title });
    this.text(x0, top + 12.5, subtitle);
    const lx = this.up(e.x1 + 20);
    let y = top;
    this.text(lx, y, "Legend", { style: this.title });
    y -= this.blockH(1, this.title) + 4;
    const entries = [...this.legend.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    for (const en of entries) {
      const [w, h] = en.family ? symbolSize(en.family, en.type!, this.kit) : [this.kit.box[0], this.kit.box[1]];
      const rowH = Math.max(h, this.blockH(1)) + 3;
      const cy = y - rowH / 2;
      if (en.family) this.items.push({ t: "symbol", family: en.family, type: en.type!, at: [r2(lx + 6), r2(cy)], rotation_deg: 0, source_id: null, params: {} });
      else {
        const [bw, bh] = [w, h];
        this.line([[lx + 6 - bw / 2, cy - bh / 2], [lx + 6 + bw / 2, cy - bh / 2], [lx + 6 + bw / 2, cy + bh / 2], [lx + 6 - bw / 2, cy + bh / 2], [lx + 6 - bw / 2, cy - bh / 2]], this.lines.thin);
      }
      this.text(lx + 16, cy + this.blockH(1) / 2, en.family ? `${en.label} (${en.type === "Standard" ? en.family : `${en.family}: ${en.type}`})` : en.label);
      y -= rowH;
    }
    y -= 8;
    this.text(lx, y, "Notes", { style: this.title });
    y -= this.blockH(1, this.title) + 3;
    const lines = ["Every value comes from the model. TBC: not in the model yet; fill it in the model and regenerate."];
    const tbc = this.tbc.lines();
    if (tbc.length) lines.push("", `Values TBC (${tbc.length}):`, ...tbc.map((t) => `- ${t}`));
    if (this.notes.length) lines.push("", ...this.notes);
    this.text(lx, y, lines.join("\n"));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Collisions

export function itemBox(item: DrawItem, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): Box | null {
  if (item.t === "symbol") return symbolBox(item.at, item.family, item.type, item.rotation_deg ?? 0, kit);
  if (item.t === "text") return textBox(item.at, item.text, item.style, item.align ?? "left", item.rotation_deg ?? 0, kit);
  return null;
}

function lineBox(item: DrawItem): Box | null {
  if (item.t !== "line") return null;
  const xs = item.points.map((p) => p[0]), ys = item.points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const EPS = 0.05;

function overlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 - EPS && b.x0 < a.x1 - EPS && a.y0 < b.y1 - EPS && b.y0 < a.y1 - EPS;
}

/** Does the segment p-q pass through the inside of box b (shrunk by EPS)? Liang-Barsky clipping. */
export function segmentHitsBox(p: number[], q: number[], b: Box): boolean {
  const x0 = b.x0 + EPS, x1 = b.x1 - EPS, y0 = b.y0 + EPS, y1 = b.y1 - EPS;
  if (x0 >= x1 || y0 >= y1) return false;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  let t0 = 0, t1 = 1;
  const clip = (pp: number, qq: number): boolean => {
    if (pp === 0) return qq >= 0;
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, p[0] - x0) && clip(dx, x1 - p[0]) && clip(-dy, p[1] - y0) && clip(dy, y1 - p[1]) && t0 < t1;
}

export interface Collision { a: string; b: string }

function describe(item: DrawItem): string {
  if (item.t === "symbol") return `symbol ${item.family}:${item.type} at [${item.at.join(", ")}]`;
  if (item.t === "text") return `text "${item.text.split("\n")[0].slice(0, 40)}" at [${item.at.join(", ")}]`;
  return `line from [${item.points[0].join(", ")}]`;
}

/**
 * Conservative overlap check: symbol and text boxes against each other, and every line segment against text boxes.
 * Lines touching symbols are how a diagram connects, so line-symbol contact is allowed; lines crossing lines too.
 */
export function collisions(view: DrawView, kit: DiagramKit = DEFAULT_DIAGRAM_KIT): Collision[] {
  const out: Collision[] = [];
  const solids = view.items.map((it) => ({ it, b: itemBox(it, kit) })).filter((s): s is { it: DrawItem; b: Box } => !!s.b)
    .sort((a, b) => a.b.x0 - b.b.x0);
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length && solids[j].b.x0 < solids[i].b.x1 - EPS; j++) {
      if (overlap(solids[i].b, solids[j].b)) out.push({ a: describe(solids[i].it), b: describe(solids[j].it) });
    }
  }
  const texts = solids.filter((s) => s.it.t === "text");
  for (const line of view.items) {
    if (line.t !== "line") continue;
    for (let k = 1; k < line.points.length; k++) {
      const p = line.points[k - 1], q = line.points[k];
      const lx0 = Math.min(p[0], q[0]), lx1 = Math.max(p[0], q[0]);
      for (const t of texts) {
        if (t.b.x0 > lx1 || t.b.x1 < lx0) continue;
        if (segmentHitsBox(p, q, t.b)) out.push({ a: describe(line), b: describe(t.it) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sorting

/** Natural order: "C2" before "C10". */
export function natural(a: string, b: string): number {
  const ca = a.match(/\d+|\D+/g) ?? [], cb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ca.length, cb.length); i++) {
    const x = ca[i], y = cb[i];
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d; }
    else if (nx !== ny) return nx ? -1 : 1;
    else { const d = x.localeCompare(y); if (d) return d; }
  }
  return ca.length - cb.length || a.localeCompare(b);
}

export const byNameId = (a: { name: string; id: string }, b: { name: string; id: string }) => natural(a.name, b.name) || a.id.localeCompare(b.id);

/** Edges in a stable order (by their ends' names, kind, id), whatever order the scan sent them in. */
export function sortEdges<E extends { from: string; to: string; kind: string; id?: string | null }>(edges: E[], byId: Map<string, { name: string; id: string }>): E[] {
  const key = (id: string) => byId.get(id) ?? { name: id, id };
  return edges.slice().sort((a, b) => byNameId(key(a.from), key(b.from)) || byNameId(key(a.to), key(b.to)) ||
    a.kind.localeCompare(b.kind) || (a.id ?? "").localeCompare(b.id ?? ""));
}

/** A Revit view name: no characters Revit refuses. */
export function viewSafe(s: string): string {
  return s.replace(/[\\:{}[\]|;<>?`~]/g, "_").replace(/\s+/g, " ").trim() || "Unnamed";
}
