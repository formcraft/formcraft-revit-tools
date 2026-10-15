import { ScanDiagram, ScanEdge, ScanNode } from "./contract.js";
import { Canvas, byNameId, natural, sortEdges, viewSafe } from "./geometry.js";
import { DiagramKit, breakerFor, param, symbolFor, symbolSize, text } from "./symbols.js";

/**
 * Electrical single-line diagrams (BS 7671 practice, IEC 60617 symbols), one view per top-level board:
 *
 *   supply (and any meter or ATS before the board) above the incomer
 *   board: title block (panel id, part type, distribution system, ways), board symbol, busbar (FMC_Wide)
 *   ways at a fixed pitch: a drop with the breaker symbol and a label block read bottom to top
 *     (circuit, rating · poles · device, cable, load and apparent load); a feeder takes two pitches and its label
 *     sits beside the drop, which runs on to the sub-board laid out below as its own busbar.
 *
 * A board with more ways than `sld_max_ways` continues on <view>-2, -3…; a board reached twice (two feeders) is drawn
 * once and the second feeder says where. Values only from the model: anything missing prints TBC and is in the notes.
 */

export interface SldContext { kit: DiagramKit; model: string; name: (wanted: string) => string }
/** A view being built; its canvas also holds the ids it shows without an item of their own (labels, counts, notes). */
export interface Page { name: string; canvas: Canvas; system: string; title: string }
export type SldPage = Page;

interface Way { edges: ScanEdge[]; targets: ScanNode[]; feeder: ScanNode | null; index: number }

interface Block {
  board: ScanNode; chunk: number; chunks: number; ways: Way[]; first: number;
  children: Map<Way, Block>; childAt: Map<Way, number>; refs: Map<Way, string>;
  titleText: string; infoText: string; infoW: number; xIn: number; labels: Map<Way, string>; labelW: number; labelH: number;
  contText: string | null; contW: number; busW: number; ownW: number; subW: number; nFeed: number;
}

const BOARD_KINDS = new Set(["board", "panel"]);
const WAY_EDGES = new Set(["feeder", "circuit"]);

export function sldPages(d: ScanDiagram, ctx: SldContext): SldPage[] {
  const kit = ctx.kit;
  const P = kit.layout.sld_way_pitch_mm, MAX = Math.max(1, Math.floor(kit.layout.sld_max_ways));
  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  const edges = sortEdges(d.edges.filter((e) => WAY_EDGES.has(e.kind) && nodes.has(e.from) && nodes.has(e.to)), nodes);
  const isBoard = (n: ScanNode) => BOARD_KINDS.has(n.kind);
  const boards = d.nodes.filter(isBoard).sort(byNameId);
  const out = new Map<string, ScanEdge[]>(), inn = new Map<string, ScanEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }
  const boardName = (b: ScanNode) => b.name || text(param(b.params, "panel_id").value) || b.id;
  const wayKey = (e: ScanEdge) => {
    const t = nodes.get(e.to)!;
    return [text(param(e.params, "way").value) ?? "", text(param(e.params, "circuit").value) ?? "~", t.name, t.id];
  };
  const waysOf = (b: ScanNode): Way[] => {
    const list = (out.get(b.id) ?? []).slice().sort((a, c) => {
      const ka = wayKey(a), kc = wayKey(c);
      for (let i = 0; i < ka.length; i++) { const r = natural(ka[i], kc[i]); if (r) return r; }
      return 0;
    });
    const ways: Way[] = [];
    const byCircuit = new Map<string, Way>();
    for (const e of list) {
      const t = nodes.get(e.to)!;
      if (isBoard(t)) { ways.push({ edges: [e], targets: [t], feeder: t, index: ways.length }); continue; }
      const ckt = text(param(e.params, "circuit").value);
      const w = ckt ? byCircuit.get(ckt) : undefined;
      if (w) { w.edges.push(e); w.targets.push(t); continue; }
      const nw: Way = { edges: [e], targets: [t], feeder: null, index: ways.length };
      ways.push(nw);
      if (ckt) byCircuit.set(ckt, nw);
    }
    return ways;
  };

  const placed = new Map<string, string>(); // board id -> view it is drawn on
  const used = new Set<string>();           // every node drawn, labelled or noted
  const pages: SldPage[] = [];
  const queue: Array<{ board: ScanNode; chunk: number; name: string; from: string | null }> = [];

  // ---- measure
  const build = (board: ScanNode, chunk: number, page: string, canvas: Canvas): Block => {
    const all = waysOf(board);
    const chunks = Math.max(1, Math.ceil(all.length / MAX));
    const first = chunk * MAX;
    const ways = all.slice(first, first + MAX);
    const name = boardName(board);
    used.add(board.id);
    if (chunk === 0) {
      placed.set(board.id, page);
      for (let k = 1; k < chunks; k++) queue.push({ board, chunk: k, name: ctx.name(`${kit.layout.view_names.e_sld}-${viewSafe(name)}-${k + 1}`), from: page });
    }
    const contText = chunk + 1 < chunks
      ? `Ways ${first + MAX + 1}-${all.length} continued on ${queue.find((q) => q.board.id === board.id && q.chunk === chunk + 1)?.name ?? "the next view"}`
      : null;
    const tbc = canvas.tbc;
    const subject = name;
    const titleText = chunk > 0 ? `${name} (continued, ways ${first + 1}-${first + ways.length})` : name;
    const ptype = param(board.params, "part_type").value;
    const info = [
      `Panel ID: ${tbc.value(param(board.params, "panel_id").value, subject, "panel ID")}`,
      `Part type: ${tbc.value(ptype, subject, "part type")}`,
      `System: ${tbc.value(param(board.params, "distribution_system").value, subject, "distribution system")}`,
      `Ways: ${tbc.value(param(board.params, "ways").value, subject, "number of ways")}`,
    ];
    if (chunk > 0) info.push(`Continued from ${placed.get(board.id) ?? ""}`);
    const infoText = info.join("\n");
    const infoW = Math.max(canvas.measure(titleText, canvas.title).w, canvas.measure(infoText).w);
    const xIn = canvas.up(infoW + 15);
    const labels = new Map<Way, string>();
    const children = new Map<Way, Block>(), refs = new Map<Way, string>();
    let waysW = 0, nFeed = 0;
    for (const w of ways) {
      const e = w.edges[0];
      const ckt = text(param(e.params, "circuit").value);
      const sub = `${name} ${ckt ? `circuit ${ckt}` : `way ${first + w.index + 1}`}`;
      const brk = breakerFor(e, kit);
      if (!brk.known) tbc.add(sub, "protective device type");
      const poles = param(e.params, "poles").value;
      const l1 = `Ckt ${tbc.value(ckt, sub, "circuit number")}`;
      const l2 = [tbc.value(param(e.params, "rating").value, sub, "rating", "A", "Rating TBC"),
        poles === null ? (tbc.add(sub, "poles"), "Poles TBC") : typeof poles === "number" ? `${poles}P` : String(poles),
        brk.known ? brk.type : `${brk.type} (type TBC)`].join(" · ");
      const l3 = tbc.value(param(e.params, "cable").value, sub, "cable", "", "Cable TBC");
      let l4: string;
      const load = param(e.params, "apparent_load").value;
      const loadText = load === null ? (tbc.add(sub, "apparent load"), "load TBC") : typeof load === "number" ? `${load} VA` : String(load);
      if (w.feeder) {
        const fname = boardName(w.feeder);
        const already = placed.get(w.feeder.id) ?? (used.has(w.feeder.id) ? page : undefined);
        if (already) { refs.set(w, already); l4 = `To ${fname} (see ${already}) · ${loadText}`; }
        else { l4 = `To ${fname} · ${loadText}`; nFeed++; }
      } else {
        for (const t of w.targets) { used.add(t.id); canvas.covered.add(t.id); }
        const names = [...new Set(w.edges.map((x, i) => text(param(x.params, "load_name").value) ?? w.targets[i].name).filter(Boolean))];
        const loadName = names.length ? names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] : (tbc.add(sub, "load name"), "Load TBC");
        l4 = `${loadName} · ${loadText}`;
      }
      labels.set(w, [l1, l2, l3, l4].join("\n"));
      waysW += w.feeder && !refs.has(w) ? 2 * P : P;
    }
    // sub-boards, measured after this board's labels so their own chunks queue after this board's
    for (const w of ways) if (w.feeder && !refs.has(w)) children.set(w, build(w.feeder, 0, page, canvas));
    const labelW = Math.max(0, ...[...labels.values()].map((l) => canvas.measure(l).w));
    const labelH = canvas.blockH(4);
    const contW = contText ? canvas.measure(contText).w + 6 : 0;
    const busW = canvas.up(Math.max(10 + waysW + 10, xIn + 10));
    const ownW = canvas.up(busW + contW);
    // each sub-board sits with its incomer under its feeder's drop when there is room, else as close as it can
    const childAt = new Map<Way, number>();
    let sx = 10, cx = 0;
    for (const w of ways) {
      const child = children.get(w);
      if (child) {
        const at = Math.max(cx, sx + P / 2 - child.xIn);
        childAt.set(w, at);
        cx = at + child.subW + 20;
      }
      sx += child ? 2 * P : P;
    }
    const kidsW = children.size ? cx - 20 : 0;
    return { board, chunk, chunks, ways, first, children, childAt, refs, titleText, infoText, infoW, xIn, labels, labelW, labelH, contText, contW, busW, ownW,
      subW: Math.max(ownW, kidsW), nFeed };
  };

  // ---- draw (x0, yTop: the block's top-left)
  const draw = (b: Block, x0: number, yTop: number, c: Canvas): void => {
    const L = c.lines;
    const src = b.board.id;
    c.text(x0, yTop, b.titleText, { style: c.title, source: src });
    c.text(x0, yTop - 7, b.infoText, { source: src });
    const xIn = x0 + b.xIn;
    const mark = symbolFor(b.board, "e_sld", kit);
    const [, sh] = c.markSize(mark);
    const symY = yTop - 10;
    c.mark(mark, xIn, symY, src);
    const yBus = yTop - 30;
    c.line([[xIn, symY - sh / 2], [xIn, yBus]], L.medium, src);
    c.line([[x0, yBus], [x0 + b.busW, yBus]], L.wide, src);
    if (b.contText) c.text(x0 + b.busW + 3, yBus + c.blockH(1) / 2, b.contText, { source: src });
    let sx = x0 + 10;
    const drops: Array<{ w: Way; x: number }> = [];
    const yEnd = yBus - 20, yLabel = yBus - 22.5;
    for (const w of b.ways) {
      const e = w.edges[0];
      const eid = e.id ?? null;
      const xd = sx + P / 2;
      const brk = breakerFor(e, kit);
      const [, bh] = symbolSize(brk.family, brk.type, kit);
      c.line([[xd, yBus], [xd, yBus - 10 + bh / 2]], L.thin, eid);
      c.symbol(brk.family, brk.type, xd, yBus - 10, eid, brk.label);
      const feedsBelow = !!w.feeder && b.children.has(w);
      c.line([[xd, yBus - 10 - bh / 2], [xd, yEnd]], feedsBelow ? L.medium : L.thin, eid);
      const label = b.labels.get(w)!;
      if (feedsBelow) { c.text(xd + 2.5, yLabel, label, { align: "right", rotation: 90, source: eid }); drops.push({ w, x: xd }); sx += 2 * P; }
      else { c.text(xd - b.labelH / 2, yLabel, label, { align: "right", rotation: 90, source: eid }); sx += P; }
    }
    const yBottom = c.down(yLabel - b.labelW - 5);
    // sub-boards below, left to right in way order. Feeders that can't drop straight jog in a channel, one track
    // each; the leftmost takes the lowest track, so no feeder runs along another.
    const channel = 5 * (drops.length + 1);
    const yChild = c.down(yBottom - channel - 5);
    drops.forEach((dr, i) => {
      const child = b.children.get(dr.w)!;
      const cx = x0 + b.childAt.get(dr.w)!;
      const childIn = cx + child.xIn;
      const track = yBottom - 5 * (drops.length - i);
      const childMark = symbolFor(child.board, "e_sld", kit);
      const [, ch] = c.markSize(childMark);
      c.line([[dr.x, yEnd], [dr.x, track], [childIn, track], [childIn, yChild - 10 + ch / 2]], L.medium, dr.w.edges[0].id ?? null);
      draw(child, cx, yChild, c);
    });
  };

  // ---- supply chain above a root board: supply, meter, ATS… (non-board nodes feeding it)
  const chainOf = (root: ScanNode): { chain: ScanNode[]; extra: ScanEdge[] } => {
    const chain: ScanNode[] = [];
    const extra: ScanEdge[] = [];
    let at = root.id;
    const seen = new Set([root.id]);
    for (;;) {
      const ins = (inn.get(at) ?? []).filter((e) => !isBoard(nodes.get(e.from)!)).sort((a, b) => byNameId(nodes.get(a.from)!, nodes.get(b.from)!));
      const next = ins.find((e) => !seen.has(e.from));
      if (!next) break;
      extra.push(...ins.filter((e) => e !== next));
      chain.unshift(nodes.get(next.from)!);
      seen.add(next.from);
      at = next.from;
    }
    return { chain, extra };
  };

  const roots = boards.filter((b) => !(inn.get(b.id) ?? []).some((e) => isBoard(nodes.get(e.from)!)));
  const rootQueue = [...roots];
  for (const b of boards) if (!rootQueue.includes(b)) rootQueue.push(b); // boards only fed by boards in a loop
  const titleOf = (n: string) => `Single-line diagram: ${n}`;

  const render = (board: ScanNode, chunk: number, name: string) => {
    const c = new Canvas(kit);
    const block = build(board, chunk, name, c);
    const yTop = 0;
    if (chunk === 0) {
      const { chain, extra } = chainOf(board);
      // stack the chain upwards from the incomer, nearest the board first
      const rows = chain.slice().reverse();
      let y = yTop;
      const xIn = block.xIn;
      let below = yTop - 10 + c.markSize(symbolFor(board, "e_sld", kit))[1] / 2; // top of the board symbol
      for (const n of rows) {
        used.add(n.id);
        const m = symbolFor(n, "e_sld", kit);
        const lines = [n.name || n.kind, ...Object.keys(n.params).sort(natural).map((k) => `${k}: ${c.tbc.value(n.params[k], n.name || n.kind, k)}`)];
        const lt = lines.join("\n");
        const h = Math.max(c.markSize(m)[1], c.blockH(lines.length));
        const cy = c.up(y + 10 + h / 2);
        const top = m.t === "drawn" ? cy : cy - c.markSize(m)[1] / 2;
        c.line([[xIn, below], [xIn, top]], c.lines.medium, n.id);
        if (m.t === "drawn") c.line([[xIn - 5, cy], [xIn + 5, cy]], c.lines.wide, n.id);
        else c.mark(m, xIn, cy, n.id);
        c.text(xIn + 8, cy + c.blockH(lines.length) / 2, lt, { source: n.id });
        below = m.t === "drawn" ? cy : cy + c.markSize(m)[1] / 2;
        y = cy + h / 2;
      }
      if (!rows.length) c.note(`${boardName(board)}: no supply is connected to it in the model.`);
      for (const e of extra) { used.add(e.from); c.covered.add(e.from); c.note(`${boardName(board)} is also fed from ${nodes.get(e.from)!.name || e.from}${text(param(e.params, "circuit").value) ? ` (${text(param(e.params, "circuit").value)})` : ""}.`); }
    }
    draw(block, 0, yTop, c);
    pages.push({ name, canvas: c, system: boardName(board), title: titleOf(block.titleText) });
  };

  for (const root of rootQueue) {
    if (placed.has(root.id)) continue;
    render(root, 0, ctx.name(`${kit.layout.view_names.e_sld}-${viewSafe(boardName(root))}`));
    while (queue.length) { const q = queue.shift()!; render(q.board, q.chunk, q.name); }
  }

  // nodes on no board: listed in the notes of the first view, never dropped
  const loose = d.nodes.filter((n) => !used.has(n.id)).sort(byNameId);
  if (loose.length && pages.length) {
    const first = pages[0].canvas;
    first.note(`Not on any board in the model (${loose.length}): ${loose.map((n) => n.name || n.id).join(", ")}.`);
    first.warn(`${loose.length} element(s) in ${d.system || "the electrical scan"} are on no board: listed in the notes of ${pages[0].name}`);
    for (const n of loose) first.covered.add(n.id);
  }
  for (const p of pages) p.canvas.frame(p.title, `${ctx.model} · ${d.system || "electrical"} · values from the model only`);
  return pages;
}
