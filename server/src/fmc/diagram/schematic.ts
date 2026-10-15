import { ScanDiagram, ScanEdge, ScanNode } from "./contract.js";
import { Canvas, byNameId, sortEdges } from "./geometry.js";
import { Page } from "./sld.js";
import { DiagramKit, Mark, param, symbolFor, text } from "./symbols.js";

/**
 * Tree schematics, left to right: the refrigerant schematic. Each outdoor unit at the top of its own group, its
 * branch joints and indoor units fanned out below; refrigerant pairs on FMC_Medium, condensate on the kit's dashed
 * style (FMC_Thin with a note while the kit has none). Every label comes from the model; pipe sizes are TBC when the
 * edge has none.
 */

export interface TreeContext { kit: DiagramKit; model: string }

interface TNode { node: ScanNode; mark: Mark; edge: ScanEdge | null; children: TNode[]; depth: number; label: string; w: number; h: number; slot: number; sub: number; x: number }

const CONDENSATE = "condensate";

export function treePage(d: ScanDiagram, name: string, ctx: TreeContext, opts: { title: string; rootKinds: string[] }): Page {
  const c = new Canvas(ctx.kit);
  const kit = ctx.kit;
  const L = c.lines;
  const nodes = d.nodes.slice().sort(byNameId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = sortEdges(d.edges.filter((e) => byId.has(e.from) && byId.has(e.to)), byId);
  const adj = new Map<string, Array<{ to: string; edge: ScanEdge }>>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push({ to: e.to, edge: e });
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ to: e.from, edge: e });
  }
  const order = (a: { to: string; edge: ScanEdge }, b: { to: string; edge: ScanEdge }) =>
    Number(a.edge.kind === CONDENSATE) - Number(b.edge.kind === CONDENSATE) || byNameId(byId.get(a.to)!, byId.get(b.to)!);

  const seen = new Set<string>();
  const treeEdges = new Set<ScanEdge>();
  const label = (n: ScanNode, e: ScanEdge | null): string => {
    const lines = [n.name || n.family || n.kind];
    if (e) {
      const subject = `${byId.get(e.from)?.name || e.from} to ${byId.get(e.to)?.name || e.to}`;
      const liquid = param(e.params, "liquid_size"), gas = param(e.params, "gas_size"), size = param(e.params, "size");
      if (liquid.present || gas.present)
        lines.push(`Liquid ${c.tbc.value(liquid.value, subject, "liquid pipe size")} · Gas ${c.tbc.value(gas.value, subject, "gas pipe size")}`);
      if (size.present || (!liquid.present && !gas.present))
        lines.push(`${e.kind === CONDENSATE ? "Condensate" : "Pipe"} ${c.tbc.value(size.value, subject, `${e.kind} pipe size`)}`);
    }
    for (const k of kit.layout.label_params) if (k in n.params) lines.push(`${k}: ${c.tbc.value(n.params[k], n.name || n.id, k)}`);
    return lines.join("\n");
  };
  const grow = (n: ScanNode, e: ScanEdge | null, depth: number): TNode => {
    seen.add(n.id);
    const mark = symbolFor(n, d.kind, kit);
    const [w, h] = c.markSize(mark);
    const t: TNode = { node: n, mark, edge: e, children: [], depth, label: label(n, e), w, h, slot: 0, sub: 0, x: 0 };
    t.slot = c.up(w + 2 + c.measure(t.label).w) + 10;
    // breadth first so a unit hangs off the nearest parent
    return t;
  };
  const roots: TNode[] = [];
  const build = (root: ScanNode) => {
    const r = grow(root, null, 0);
    roots.push(r);
    const queue: TNode[] = [r];
    while (queue.length) {
      const t = queue.shift()!;
      for (const nb of (adj.get(t.node.id) ?? []).slice().sort(order)) {
        if (seen.has(nb.to)) continue;
        const child = grow(byId.get(nb.to)!, nb.edge, t.depth + 1);
        treeEdges.add(nb.edge);
        t.children.push(child);
        queue.push(child);
      }
    }
  };
  for (const n of nodes) if (opts.rootKinds.includes(n.kind) && !seen.has(n.id)) build(n);
  const orphans: string[] = [];
  for (const n of nodes) if (!seen.has(n.id)) { orphans.push(n.name || n.id); build(n); }
  if (orphans.length) c.warn(`${orphans.length} element(s) not connected to an outdoor unit, drawn on their own: ${orphans.join(", ")}`);

  // ---- measure
  const all: TNode[] = [];
  const walk = (t: TNode) => { all.push(t); t.children.forEach(walk); };
  roots.forEach(walk);
  const sub = (t: TNode): number => (t.sub = Math.max(t.slot, t.children.reduce((s, k) => s + sub(k), 0)));
  roots.forEach(sub);
  const depthMax = Math.max(0, ...all.map((t) => t.depth));
  const hmax = (dd: number) => Math.max(6, ...all.filter((t) => t.depth === dd).map((t) => t.h));
  const labelMax = (dd: number) => Math.max(0, ...all.filter((t) => t.depth === dd).map((t) => c.measure(t.label).h));
  const rowY: number[] = [0];
  for (let dd = 0; dd < depthMax; dd++) {
    const rowH = c.up(Math.max(kit.layout.tree_row_mm, 1.6 + labelMax(dd) + 14 + hmax(dd + 1) / 2, hmax(dd) / 2 + hmax(dd + 1) / 2 + 15));
    rowY.push(rowY[dd] - rowH);
  }
  const place = (t: TNode, left: number) => {
    t.x = c.snap(left + t.w / 2);
    let l = left;
    for (const k of t.children) { place(k, l); l += k.sub; }
  };
  let left = 0;
  for (const r of roots) { place(r, left); left += r.sub + 10; }

  // ---- draw
  const dashed = L.dashed;
  let condensate = false;
  for (const t of all) {
    const y = rowY[t.depth];
    c.mark(t.mark, t.x, y, t.node.id);
    c.text(t.x + t.w / 2 + 2, y + c.blockH(1) / 2, t.label, { source: t.node.id });
    if (!t.children.length) continue;
    const childTop = rowY[t.depth + 1] + hmax(t.depth + 1) / 2;
    const groups: Array<{ kids: TNode[]; style: string; bus: number }> = [];
    const refr = t.children.filter((k) => k.edge?.kind !== CONDENSATE), cond = t.children.filter((k) => k.edge?.kind === CONDENSATE);
    if (refr.length) groups.push({ kids: refr, style: L.medium, bus: childTop + 10 });
    if (cond.length) { condensate = true; groups.push({ kids: cond, style: dashed ?? L.thin, bus: childTop + 5 }); }
    groups.forEach((g, i) => {
      const off = groups.length > 1 && i === 1 ? Math.min(2, t.w / 2 - 0.5) : 0;
      const tx = t.x + off;
      c.line([[tx, y - t.h / 2], [tx, g.bus]], g.style);
      const xs = [tx, ...g.kids.map((k) => k.x)];
      c.line([[Math.min(...xs), g.bus], [Math.max(...xs), g.bus]], g.style);
      for (const k of g.kids) c.line([[k.x, g.bus], [k.x, rowY[k.depth] + k.h / 2]], g.style, k.edge?.id ?? null);
    });
  }
  if (condensate && !dashed) {
    c.note("Condensate lines are drawn on FMC_Thin: the kit's diagram table has no dashed line style yet (styles.lines.dashed).");
    c.warn("No dashed line style in the kit's diagram table: condensate drawn solid on the thin style (a kit change request)");
  }
  for (const e of edges) if (!treeEdges.has(e)) {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    const size = text(param(e.params, "size").value);
    c.note(`Also connected: ${a.name || a.id} to ${b.name || b.id} (${e.kind}${size ? `, ${size}` : ""}).`);
  }
  if (!nodes.length) c.note("Nothing in the model for this diagram yet.");
  return { name, canvas: c, system: d.system, title: opts.title };
}
