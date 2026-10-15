import { ScanDiagram, ScanEdge, ScanNode, ScanResult } from "./contract.js";
import { Canvas, byNameId, natural, sortEdges } from "./geometry.js";
import { Page } from "./sld.js";
import { DiagramKit, breakerFor, param, symbolFor, text } from "./symbols.js";

/**
 * Electrical power riser, from the e_sld graph (boards and feeders; final circuits stay on the SLDs):
 *
 *   one band per level, top level at the top, level name and elevation at the left;
 *   the supply and each board on its own level, boards on one level side by side, each with its kit board symbol and a
 *   block: name (panel ID), part type, ways, the feeder that serves it (rating · poles · device, cable) and "See <SLD>";
 *   feeders leave a board from the right of its symbol, run along a track at the foot of the board's level band and
 *   rise or drop on the fed board's own column, so no two feeders share a line.
 *
 * Every board has a column of its own (tree order from the supply), which keeps the risers clear of each other.
 */

export interface RiserContext { kit: DiagramKit; model: string; sldView: (boardId: string) => string | null }

const BOARD_KINDS = new Set(["board", "panel"]);
const FEED_EDGES = new Set(["feeder", "circuit"]);

export function powerRiserPage(d: ScanDiagram, levels: ScanResult["levels"], name: string, ctx: RiserContext, title: string): Page {
  const c = new Canvas(ctx.kit);
  const kit = ctx.kit;
  const L = c.lines;
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const isBoard = (n: ScanNode) => BOARD_KINDS.has(n.kind);
  const edgesAll = sortEdges(d.edges.filter((e) => FEED_EDGES.has(e.kind) && byId.has(e.from) && byId.has(e.to)), byId);
  // riser nodes: supplies, boards, and a meter or ATS on the way to a board
  const riser = new Set(d.nodes.filter((n) => isBoard(n) || n.kind === "supply").map((n) => n.id));
  for (const e of edgesAll) if (isBoard(byId.get(e.to)!) && ["meter", "equipment"].includes(byId.get(e.from)!.kind)) riser.add(e.from);
  const edges = edgesAll.filter((e) => riser.has(e.from) && riser.has(e.to));
  const nodes = d.nodes.filter((n) => riser.has(n.id)).sort(byNameId);

  // tree order: the first feeder into a node is drawn; any other is a note
  const feeds = new Map<string, ScanEdge>();
  const kids = new Map<string, ScanNode[]>();
  for (const e of edges) {
    if (feeds.has(e.to) || e.to === e.from) {
      if (e.to !== e.from) c.note(`${byId.get(e.to)!.name || e.to} is also fed from ${byId.get(e.from)!.name || e.from}.`);
      continue;
    }
    feeds.set(e.to, e);
    (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(byId.get(e.to)!);
  }
  const order: ScanNode[] = [];
  const seen = new Set<string>();
  const visit = (n: ScanNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    order.push(n);
    for (const k of (kids.get(n.id) ?? []).slice().sort(byNameId)) visit(k);
  };
  const roots = nodes.filter((n) => !feeds.has(n.id)).sort((a, b) => Number(b.kind === "supply") - Number(a.kind === "supply") || byNameId(a, b));
  for (const r of roots) visit(r);
  for (const n of nodes) visit(n); // a loop of boards: start anywhere, in name order

  // levels: a supply with no level sits with the board it feeds
  const levelOf = new Map<string, string>();
  for (const n of order) {
    let lv = n.level;
    if (!lv && n.kind === "supply") lv = (kids.get(n.id) ?? []).map((k) => k.level).find((x): x is string => !!x) ?? null;
    levelOf.set(n.id, lv && levels.some((l) => l.id === lv) ? lv : "__none");
    if (levelOf.get(n.id) === "__none" && n.kind !== "supply") c.tbc.add(`${n.name || n.id}`, "level");
  }
  const bands = levels.slice().sort((a, b) => b.elevation_mm - a.elevation_mm || natural(a.name, b.name) || a.id.localeCompare(b.id))
    .map((l) => ({ id: l.id, title: `${l.name || "Level TBC"}\n${l.elevation_mm >= 0 ? "+" : ""}${(l.elevation_mm / 1000).toFixed(3)}` }));
  if ([...levelOf.values()].includes("__none")) bands.push({ id: "__none", title: "No level" });

  // ---- measure each node's block
  const nameOf = (n: ScanNode) => text(param(n.params, "panel_id").value) ?? (n.name || n.id);
  interface Blk { n: ScanNode; head: string; body: string; w: number; h: number; symW: number; symH: number; slot: number }
  const blocks = new Map<string, Blk>();
  for (const n of order) {
    const m = symbolFor(n, "e_power_riser", kit);
    const [sw, sh] = m.t === "drawn" ? [10, 2] : c.markSize(m);
    const head = nameOf(n);
    const lines: string[] = [];
    if (isBoard(n)) {
      lines.push(`Part type: ${c.tbc.value(param(n.params, "part_type").value, head, "part type")}`);
      lines.push(`Ways: ${c.tbc.value(param(n.params, "ways").value, head, "number of ways")}`);
    } else for (const k of Object.keys(n.params).sort(natural)) lines.push(`${k}: ${c.tbc.value(n.params[k], head, k)}`);
    const e = feeds.get(n.id);
    if (e && byId.get(e.from)!.kind === "supply") {
      // the incoming supply has no outgoing way of its own: name it, and its cable when the model has one
      lines.push(`From ${nameOf(byId.get(e.from)!)}`);
      const cable = text(param(e.params, "cable").value);
      if (cable) lines.push(`Cable: ${cable}`);
    } else if (e) {
      const from = nameOf(byId.get(e.from)!);
      const ckt = text(param(e.params, "circuit").value);
      const subject = `${head} feeder`;
      const brk = breakerFor(e, kit);
      if (!brk.known) c.tbc.add(subject, "protective device type");
      const poles = param(e.params, "poles").value;
      lines.push(`From ${from}${ckt ? ` ckt ${ckt}` : ""}: ${c.tbc.value(param(e.params, "rating").value, subject, "rating", "A", "Rating TBC")} · ` +
        `${poles === null ? (c.tbc.add(subject, "poles"), "Poles TBC") : typeof poles === "number" ? `${poles}P` : String(poles)} · ${brk.known ? brk.type : `${brk.type} (type TBC)`}`);
      lines.push(`Cable: ${c.tbc.value(param(e.params, "cable").value, subject, "cable")}`);
    }
    if (isBoard(n)) lines.push(`See ${ctx.sldView(n.id) ?? `${kit.layout.view_names.e_sld}-${head}`}`);
    const body = lines.join("\n");
    const w = Math.max(c.measure(head, c.title).w, lines.length ? c.measure(body).w : 0);
    const h = c.blockH(1, c.title) + 2 + (lines.length ? c.blockH(lines.length) : 0);
    blocks.set(n.id, { n, head, body, w, h, symW: sw, symH: sh, slot: c.up(sw + 3 + w) + 15 });
  }

  // ---- columns and bands
  const LW = c.up(Math.max(0, ...bands.map((b) => c.measure(b.title).w)) + 10);
  const colX = new Map<string, number>(); // symbol centre
  let x = LW;
  for (const n of order) { const b = blocks.get(n.id)!; colX.set(n.id, c.snap(x + 5 + b.symW / 2)); x += b.slot; }
  const totalW = c.up(x);
  const outgoing = (bandId: string) => order.filter((n) => levelOf.get(n.id) === bandId && (kids.get(n.id) ?? []).length);
  const tracks = new Map<string, number>(); // feeder (child id) -> track y
  const symY = new Map<string, number>();
  let yT = 0;
  for (const band of bands) {
    const here = order.filter((n) => levelOf.get(n.id) === band.id);
    const cy = yT - 10;
    let content = yT - 5;
    for (const n of here) {
      const b = blocks.get(n.id)!;
      const sx = colX.get(n.id)!;
      symY.set(n.id, cy);
      const m = symbolFor(n, "e_power_riser", kit);
      if (m.t === "drawn") c.line([[sx - 5, cy], [sx + 5, cy]], L.wide, n.id);
      else c.mark(m, sx, cy, n.id);
      const tx = sx + b.symW / 2 + 3;
      c.text(tx, yT - 5, b.head, { style: c.title, source: n.id });
      if (b.body) c.text(tx, yT - 5 - c.blockH(1, c.title) - 2, b.body, { source: n.id });
      content = Math.min(content, yT - 5 - b.h, cy - b.symH / 2);
    }
    // a track per feeder leaving this level, at the foot of the band
    let k = 0;
    for (const p of outgoing(band.id)) for (const kid of (kids.get(p.id) ?? []).slice().sort((a, b) => colX.get(a.id)! - colX.get(b.id)!)) {
      tracks.set(kid.id, c.down(content - 5) - 5 * k++);
    }
    const bottom = c.down(Math.min(yT - kit.layout.band_min_height_mm, c.down(content - 5) - 5 * Math.max(0, k - 1) - 7.5));
    c.text(0, yT - 2, band.title);
    c.line([[0, yT], [totalW, yT]], L.thin);
    yT = bottom;
  }
  c.line([[0, yT], [totalW, yT]], L.thin);

  // ---- feeders: out of the right of the parent's symbol, along its track, up or down the child's column
  for (const p of order) {
    const list = (kids.get(p.id) ?? []).filter((k) => tracks.has(k.id));
    if (!list.length) continue;
    const pb = blocks.get(p.id)!;
    const px = colX.get(p.id)! + Math.min(2.5, pb.symW / 2 - 0.5), py = symY.get(p.id)! - pb.symH / 2;
    c.line([[px, py], [px, Math.min(...list.map((k) => tracks.get(k.id)!))]], L.medium, p.id);
    for (const n of list) {
      const nb = blocks.get(n.id)!;
      const cx = colX.get(n.id)!, cy = symY.get(n.id)!;
      const track = tracks.get(n.id)!;
      const end = cy > track ? cy - nb.symH / 2 : cy + nb.symH / 2;
      c.line([[px, track], [cx, track], [cx, end]], L.medium, feeds.get(n.id)!.id ?? null);
    }
  }
  c.note("Final circuits are not drawn here: they are on each board's single-line diagram (See …).");
  if (!order.length) c.note("No boards in the model for this diagram yet.");
  return { name, canvas: c, system: d.system, title };
}
