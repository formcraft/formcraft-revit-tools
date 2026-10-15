import { ScanDiagram, ScanEdge, ScanNode } from "./contract.js";
import { Canvas, byNameId, natural, sortEdges } from "./geometry.js";
import { Page } from "./sld.js";
import { DiagramKit, Mark, param, symbolFor, text } from "./symbols.js";

/**
 * Band layouts: risers and level schematics (fire alarm zone chart, ELV, fire fighting, water, drainage) and the
 * lightning protection schematic (bands by part instead of by level).
 *
 *   one horizontal band per level, top level at the top, level name and elevation at the left;
 *   one column per zone, system, riser or stack: a riser line (spine) with a tap line in each band it serves;
 *   in each band, plant drawn one by one in flow order (name under it) and devices counted per symbol ("×12");
 *   pipe sizes from the edges beside the riser between bands (TBC when the model has none);
 *   the panel, NVR or MET in a base row under the bands, joined to every riser by a backbone.
 */

export interface BandSetup {
  title: string;
  bands: Array<{ id: string; title: string }>;
  bandOf: (n: ScanNode) => string;
  /** Column key and header for a node (spines: the spine's own column). */
  columnOf: (n: ScanNode, m: Mark) => { key: string; header: string };
  /** Extra header lines from the nodes in a column (fire alarm: the loops). */
  headerExtra?: (nodes: ScanNode[]) => string[];
  isBase: (n: ScanNode, m: Mark) => boolean;
  isCounted: (n: ScanNode, m: Mark) => boolean;
  baseTitle: string;
  /** Bands are building levels: an element with no level goes in a "No level" band and its level is TBC. */
  levelBands?: boolean;
}

export interface BandContext { kit: DiagramKit; model: string }

const PIPE_EDGES = new Set(["pipe", "duct", "refrigerant", "condensate"]);
export const COUNTED_KINDS = new Set(["device", "fixture", "sprinkler", "hose_reel"]);

interface Item { node: ScanNode; mark: Mark }
interface Group { key: string; mark: Mark; nodes: ScanNode[]; name: string }
interface Cell { singles: Item[]; counted: Map<string, Group> }

/** Pipe size text from edges: distinct values; a null records TBC. */
function sizesOf(edges: ScanEdge[], c: Canvas, subject: string): string {
  const vals: string[] = [];
  let missing = false;
  for (const e of edges) {
    const parts = (["size", "liquid_size", "gas_size"] as const).map((k) => param(e.params, k)).filter((p) => p.present);
    if (!parts.length || parts.every((p) => text(p.value) === null)) { missing = true; continue; }
    for (const p of parts) { const t = text(p.value); if (t && !vals.includes(t)) vals.push(t); }
  }
  vals.sort(natural);
  if (missing) { c.tbc.add(subject, "pipe size"); vals.push("TBC"); }
  return vals.join(" / ");
}

/** Flow order from the edges (sources first), ties by name: plant reads tank, pump, valve, riser. */
function flowRank(nodes: ScanNode[], edges: ScanEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    (next.get(e.from) ?? next.set(e.from, []).get(e.from)!).push(e.to);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sorted = nodes.slice().sort(byNameId);
  // depth = the longest run of edges from a source (a loop is broken at its first node by name), then by name
  const depth = new Map<string, number>();
  const ready = sorted.filter((n) => indeg.get(n.id) === 0);
  for (const n of ready) depth.set(n.id, 0);
  const done = new Set<string>();
  while (done.size < nodes.length) {
    if (!ready.length) { const left = sorted.find((n) => !done.has(n.id))!; ready.push(left); indeg.set(left.id, 0); if (!depth.has(left.id)) depth.set(left.id, 0); }
    ready.sort(byNameId);
    const n = ready.shift()!;
    if (done.has(n.id)) continue;
    done.add(n.id);
    for (const t of next.get(n.id) ?? []) {
      if (done.has(t)) continue;
      depth.set(t, Math.max(depth.get(t) ?? 0, depth.get(n.id)! + 1));
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
      if (indeg.get(t) === 0) ready.push(byId.get(t)!);
    }
  }
  const order = sorted.slice().sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || byNameId(a, b));
  return new Map(order.map((n, i) => [n.id, i]));
}

/** Each node's nearest spine (riser, stack, down conductor) over the edges; base nodes don't pass it on. */
export function nearestSpine(d: ScanDiagram, isSpine: (n: ScanNode) => boolean, isBase: (n: ScanNode) => boolean): Map<string, ScanNode> {
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();
  for (const e of d.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  for (const list of adj.values()) list.sort((a, b) => byNameId(nodes.get(a)!, nodes.get(b)!));
  const owner = new Map<string, ScanNode>();
  const queue: string[] = [];
  for (const s of d.nodes.filter(isSpine).sort(byNameId)) { owner.set(s.id, s); queue.push(s.id); }
  while (queue.length) {
    const id = queue.shift()!;
    if (isBase(nodes.get(id)!) && !isSpine(nodes.get(id)!)) continue;
    for (const nb of adj.get(id) ?? []) if (!owner.has(nb)) { owner.set(nb, owner.get(id)!); queue.push(nb); }
  }
  return owner;
}

export function bandPage(d: ScanDiagram, name: string, ctx: BandContext, setup: BandSetup): Page {
  const c = new Canvas(ctx.kit);
  const L = c.lines;
  const kit = ctx.kit;
  const nodes = d.nodes.slice().sort(byNameId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = sortEdges(d.edges.filter((e) => byId.has(e.from) && byId.has(e.to)), byId);
  const rank = flowRank(nodes, edges);
  const pipes = edges.filter((e) => PIPE_EDGES.has(e.kind))
    .sort((a, b) => rank.get(a.from)! - rank.get(b.from)! || rank.get(a.to)! - rank.get(b.to)! || a.kind.localeCompare(b.kind) || (a.id ?? "").localeCompare(b.id ?? ""));

  // ---- assign
  const columns = new Map<string, { header: string; nodes: ScanNode[]; spine: ScanNode | null }>();
  const cells = new Map<string, Cell>(); // band|column
  const base: Item[] = [];
  const where = new Map<string, { band: string; col: string; counted: boolean } | "base">();
  const allBands = setup.bands.some((b) => b.id === "__none") ? setup.bands : [...setup.bands, { id: "__none", title: "No level" }];
  const bandIds = new Set(allBands.map((b) => b.id));
  const cellOf = (b: string, col: string) => {
    const k = `${b}\u0000${col}`;
    return cells.get(k) ?? cells.set(k, { singles: [], counted: new Map() }).get(k)!;
  };
  for (const n of nodes) {
    const m = symbolFor(n, d.kind, kit);
    if (setup.isBase(n, m)) { base.push({ node: n, mark: m }); where.set(n.id, "base"); continue; }
    const { key, header } = setup.columnOf(n, m);
    const col = columns.get(key) ?? columns.set(key, { header, nodes: [], spine: null }).get(key)!;
    col.nodes.push(n);
    if (m.t === "drawn") { col.spine = n; continue; } // a riser drawn as the riser line: its name heads the column
    const wanted = setup.bandOf(n);
    const band = bandIds.has(wanted) ? wanted : "__none";
    if (band === "__none" && setup.levelBands) c.tbc.add("Elements with no level", "level");
    const counted = setup.isCounted(n, m);
    where.set(n.id, { band, col: key, counted });
    const cell = cellOf(band, key);
    if (!counted) { cell.singles.push({ node: n, mark: m }); continue; }
    const generic = m.t === "symbol" && !!m.rule.generic;
    const gkey = m.t === "symbol" ? `${m.family}:${m.type}${generic ? `|${n.type || n.family}` : ""}` : `box|${m.label}`;
    const g = cell.counted.get(gkey) ?? cell.counted.set(gkey, { key: gkey, mark: m, nodes: [],
      name: m.t === "box" ? m.label : generic ? (n.type || n.family || m.label) : "" }).get(gkey)!;
    g.nodes.push(n);
  }
  for (const cell of cells.values()) cell.singles.sort((a, b) => (rank.get(a.node.id)! - rank.get(b.node.id)!) || byNameId(a.node, b.node));
  base.sort((a, b) => (rank.get(a.node.id)! - rank.get(b.node.id)!) || byNameId(a.node, b.node));
  const colKeys = [...columns.keys()].sort((a, b) => natural(columns.get(a)!.header, columns.get(b)!.header) || natural(a, b));
  const bands = allBands.filter((b) => b.id !== "__none" || [...where.values()].some((w) => w !== "base" && w.band === "__none"));

  // ---- pipe sizes: between bands beside the riser, the rest in the notes
  const seg = new Map<string, ScanEdge[]>(); // band|column -> edges on the riser below that band
  const groupEdges = new Map<Group, ScanEdge[]>();
  const groupOf = (id: string): Group | null => {
    const w = where.get(id);
    if (!w || w === "base" || !w.counted) return null;
    for (const g of cellOf(w.band, w.col).counted.values()) if (g.nodes.some((n) => n.id === id)) return g;
    return null;
  };
  const bandIndex = new Map(bands.map((b, i) => [b.id, i]));
  const loose: ScanEdge[] = [];
  for (const e of pipes) {
    const ga = groupOf(e.from), gb = groupOf(e.to);
    if (ga || gb) { for (const g of [ga, gb]) if (g) (groupEdges.get(g) ?? groupEdges.set(g, []).get(g)!).push(e); continue; }
    const wa = where.get(e.from), wb = where.get(e.to);
    if (wa && wb && wa !== "base" && wb !== "base" && wa.col === wb.col && wa.band !== wb.band) {
      const upper = (bandIndex.get(wa.band) ?? 0) < (bandIndex.get(wb.band) ?? 0) ? wa.band : wb.band;
      const k = `${upper}\u0000${wa.col}`;
      (seg.get(k) ?? seg.set(k, []).get(k)!).push(e);
    } else loose.push(e);
  }

  // ---- measure
  const singleLabel = (n: ScanNode): string => {
    const lines = [n.name || n.family || n.kind];
    for (const k of kit.layout.label_params) if (k in n.params) lines.push(`${k}: ${c.tbc.value(n.params[k], n.name || n.id, k)}`);
    return lines.join("\n");
  };
  const groupText = (g: Group, subject: string): string => {
    const sizes = groupEdges.has(g) ? sizesOf(groupEdges.get(g)!, c, subject) : "";
    return [`×${g.nodes.length}`, g.name, sizes ? `· ${sizes}` : ""].filter(Boolean).join(" ");
  };
  interface Slot { x: number; w: number; item?: Item; group?: Group; label: string; size: [number, number] }
  const slotsFor = (cell: Cell | undefined, subject: string): Slot[] => {
    if (!cell) return [];
    const out: Slot[] = [];
    for (const it of cell.singles) {
      const size = c.markSize(it.mark);
      const label = singleLabel(it.node);
      out.push({ x: 0, w: c.up(Math.max(size[0], c.measure(label).w)) + 10, item: it, label, size });
    }
    for (const g of [...cell.counted.values()].sort((a, b) => natural(a.mark.label, b.mark.label) || natural(a.key, b.key))) {
      const size = c.markSize(g.mark);
      const label = groupText(g, `${g.name || g.mark.label} (${subject})`);
      out.push({ x: 0, w: c.up(size[0] + 2 + c.measure(label).w) + 10, group: g, label, size });
    }
    return out;
  };
  const bandSlots = new Map<string, Slot[]>();
  for (const b of bands) for (const k of colKeys) bandSlots.set(`${b.id}\u0000${k}`, slotsFor(cells.get(`${b.id}\u0000${k}`), `${b.title.split("\n")[0]}, ${columns.get(k)!.header}`));
  const headers = new Map(colKeys.map((k) => {
    const col = columns.get(k)!;
    const extra = setup.headerExtra ? setup.headerExtra(col.nodes) : [];
    return [k, [col.header, ...extra].join("\n")];
  }));
  const segText = new Map<string, string>();
  for (const [k, list] of seg) segText.set(k, sizesOf(list, c, `Riser below ${k.split("\u0000")[0]}`));

  const LW = c.up(Math.max(...bands.map((b) => c.measure(b.title).w), base.length ? c.measure(setup.baseTitle).w : 0) + 10);
  const colX = new Map<string, number>();
  let x = LW;
  for (const k of colKeys) {
    colX.set(k, x);
    let w = c.measure(headers.get(k)!).w + 10;
    for (const b of bands) w = Math.max(w, 17.5 + (bandSlots.get(`${b.id}\u0000${k}`) ?? []).reduce((s, sl) => s + sl.w, 0) + 5);
    x += c.up(w);
  }
  let totalW = x;

  // ---- bands, top down
  let yT = 0;
  const tapY = new Map<string, number>();
  const bandBottom = new Map<string, number>();
  const th1 = c.blockH(1);
  for (const k of colKeys) c.text(colX.get(k)! + 10, yT + 2 + c.measure(headers.get(k)!).h, headers.get(k)!, { source: columns.get(k)!.spine?.id ?? null });
  for (const b of bands) {
    const all = colKeys.flatMap((k) => bandSlots.get(`${b.id}\u0000${k}`) ?? []);
    const hmax = Math.max(6, ...all.map((s) => s.size[1]));
    const tap = yT - 5;
    const cy = c.down(tap - 2.5 - hmax / 2);
    const labelTop = cy - hmax / 2 - 1.5;
    let bottom = Math.min(cy - Math.max(hmax / 2, th1 / 2), ...all.filter((s) => s.item).map((s) => labelTop - c.measure(s.label).h)) - 5;
    const segNeed = Math.max(0, ...colKeys.map((k) => segText.has(`${b.id}\u0000${k}`) ? c.measure(segText.get(`${b.id}\u0000${k}`)!).w + 10 : 0));
    const h = c.up(Math.max(kit.layout.band_min_height_mm, yT - bottom, segNeed));
    bottom = yT - h;
    tapY.set(b.id, tap);
    bandBottom.set(b.id, bottom);
    c.text(0, yT - 2, b.title);
    for (const k of colKeys) {
      const slots = bandSlots.get(`${b.id}\u0000${k}`) ?? [];
      if (!slots.length) continue;
      const xs = colX.get(k)! + 10;
      let sx = xs + 7.5;
      let last = xs;
      for (const s of slots) {
        if (s.item) {
          const px = c.snap(sx + (s.w - 5) / 2);
          c.mark(s.item.mark, px, cy, s.item.node.id);
          c.line([[px, tap], [px, cy + s.size[1] / 2]], L.thin, s.item.node.id);
          c.text(px, labelTop, s.label, { align: "center", source: s.item.node.id });
          last = px;
        } else if (s.group) {
          const px = c.snap(sx + s.size[0] / 2 + 2.5);
          const ids = s.group.nodes.map((n) => n.id);
          c.mark(s.group.mark, px, cy, ids[0]);
          for (const id of ids) c.covered.add(id);
          c.line([[px, tap], [px, cy + s.size[1] / 2]], L.thin);
          c.text(px + s.size[0] / 2 + 2, cy + th1 / 2, s.label);
          last = px;
        }
        sx += s.w;
      }
      c.line([[xs, tap], [last, tap]], L.thin);
    }
    yT = bottom;
  }
  const lastBottom = yT;

  // ---- base row: panel, NVR, MET…, on a backbone that every riser comes down to
  let yBB: number | null = null;
  if (base.length) {
    yBB = lastBottom - 5;
    const hmax = Math.max(6, ...base.map((b) => c.markSize(b.mark)[1]));
    const cy = c.down(yBB - 2.5 - hmax / 2);
    const labelTop = cy - hmax / 2 - 1.5;
    c.text(0, yBB - 2, setup.baseTitle);
    let sx = LW + 10;
    const xs: number[] = [];
    for (const b of base) {
      const label = singleLabel(b.node);
      const size = c.markSize(b.mark);
      const w = c.up(Math.max(size[0], c.measure(label).w)) + 10;
      const px = c.snap(sx + (w - 5) / 2);
      c.mark(b.mark, px, cy, b.node.id);
      c.line([[px, yBB], [px, cy + size[1] / 2]], L.medium, b.node.id);
      c.text(px, labelTop, label, { align: "center", source: b.node.id });
      xs.push(px);
      sx += w;
    }
    totalW = Math.max(totalW, c.up(sx));
    const spines = colKeys.filter((k) => bands.some((b) => (bandSlots.get(`${b.id}\u0000${k}`) ?? []).length)).map((k) => colX.get(k)! + 10);
    const all = [...xs, ...spines];
    c.line([[Math.min(...all), yBB], [Math.max(...all), yBB]], L.medium);
  }

  // ---- floor lines and risers
  for (const b of bands) c.line([[0, tapY.get(b.id)! + 5], [totalW, tapY.get(b.id)! + 5]], L.thin);
  c.line([[0, lastBottom], [totalW, lastBottom]], L.thin);
  for (const k of colKeys) {
    const served = bands.filter((b) => (bandSlots.get(`${b.id}\u0000${k}`) ?? []).length);
    if (!served.length) continue;
    const xs = colX.get(k)! + 10;
    const top = tapY.get(served[0].id)!;
    const bottom = yBB ?? tapY.get(served[served.length - 1].id)!;
    const spine = columns.get(k)!.spine;
    if (top > bottom) c.line([[xs, top], [xs, bottom]], L.medium, spine?.id ?? null);
    for (const b of bands) {
      const t = segText.get(`${b.id}\u0000${k}`);
      if (!t) continue;
      const mid = (tapY.get(b.id)! + bandBottom.get(b.id)!) / 2;
      c.text(xs - 1.5 - th1, mid, t, { align: "center", rotation: 90 });
    }
  }
  for (const e of loose) {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    c.note(`Pipework ${a.name || a.id} to ${b.name || b.id}: ${sizesOf([e], c, `${a.name || a.id} to ${b.name || b.id}`)}`);
  }
  for (const col of columns.values()) if (col.spine) c.covered.add(col.spine.id);
  if (!nodes.length) c.note("Nothing in the model for this diagram yet.");
  return { name, canvas: c, system: d.system, title: setup.title };
}
