import { ScanDiagram, ScanEdge, ScanNode, ScanResult } from "./contract.js";
import { Canvas, byNameId, natural, sortEdges } from "./geometry.js";
import { Page } from "./sld.js";
import { DiagramKit, Mark, param, symbolFor, text } from "./symbols.js";

/**
 * Building automation and controls (m_controls, added 15 Oct): two views from one scan graph.
 *
 * Riser (`<prefix>-Riser`): the controls network.
 *   one band per level, top level at the top, level name and elevation at the left;
 *   each controller or gateway with no network node under it sits on its own level in a column of its own: its kit
 *   symbol, a block (mark, protocol, points by type AI/AO/DI/DO, "See <points view>") and a row of its points counted by
 *   kit symbol ("×3"); its link drops from the symbol to its supervisor's track, labelled with the link's protocol;
 *   supervisors (the head end, and gateways with controllers under them) sit in the base row under the bands, each with
 *   a track the controllers under it come down to, and its level and backbone protocol in its label.
 * Points list (`<prefix>-Points`): a table per controller (mark, device, point type, signal) when it has at most
 *   `controls_points_max` points, else the counts and a reference to the controls points schedule.
 *
 * Rule 5: values only from the model. A missing protocol, point type, signal or mark prints TBC and is in the notes;
 * points the model doesn't tie to a controller are listed, never guessed onto one.
 */

export interface ControlsContext { kit: DiagramKit; model: string; name: (wanted: string) => string }

const NET_KINDS = new Set(["controller", "gateway"]);
const POINT_TYPES = ["AI", "AO", "DI", "DO"];

interface Points { list: ScanNode[]; byType: Map<string, number>; tbc: number }

function list(names: string[], max = 20): string {
  return names.length > max ? `${names.slice(0, max).join(", ")} …and ${names.length - max} more` : names.join(", ");
}

export function controlsPages(d: ScanDiagram, levels: ScanResult["levels"], prefix: string, ctx: ControlsContext, title: string): Page[] {
  const kit = ctx.kit;
  const nodes = d.nodes.slice().sort(byNameId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = sortEdges(d.edges.filter((e) => e.kind === "data" && byId.has(e.from) && byId.has(e.to) && e.from !== e.to), byId);
  const isNet = (n: ScanNode) => NET_KINDS.has(n.kind);
  const net = nodes.filter(isNet);
  const riserName = ctx.name(`${prefix}-Riser`);
  const pointsName = ctx.name(`${prefix}-Points`);

  const c = new Canvas(kit);
  const L = c.lines;

  // ---- the network: each network node's supervisor (the first link into it that makes no loop)
  const parent = new Map<string, ScanEdge>();
  const kids = new Map<string, ScanNode[]>();
  const loops: string[] = [];
  for (const e of edges) {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    if (!isNet(a) || !isNet(b) || parent.has(b.id)) continue;
    let up: string | undefined = a.id, loop = false;
    for (let i = 0; up && i <= net.length; i++) { if (up === b.id) { loop = true; break; } up = parent.get(up)?.from; }
    if (loop) { loops.push(`${a.name || a.id} and ${b.name || b.id}`); continue; }
    parent.set(b.id, e);
    (kids.get(a.id) ?? kids.set(a.id, []).get(a.id)!).push(b);
  }
  // ---- points: each device on the first network node that names it
  const owner = new Map<string, ScanNode>();
  const pointsOf = new Map<string, ScanNode[]>();
  for (const e of edges) {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    if (!isNet(a) || isNet(b) || owner.has(b.id)) continue;
    owner.set(b.id, a);
    (pointsOf.get(a.id) ?? pointsOf.set(a.id, []).get(a.id)!).push(b);
  }

  const order: ScanNode[] = [];
  const seen = new Set<string>();
  const visit = (n: ScanNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    order.push(n);
    for (const k of (kids.get(n.id) ?? []).slice().sort(byNameId)) visit(k);
  };
  for (const r of net.filter((n) => !parent.has(n.id))) visit(r);
  for (const n of net) visit(n);
  const isBase = (n: ScanNode) => (kids.get(n.id) ?? []).length > 0;
  const base = order.filter(isBase);
  const placed = order.filter((n) => !isBase(n));

  const headOf = (n: ScanNode) => text(param(n.params, "mark").value) ?? (n.name || n.id);
  const levelName = new Map(levels.map((l) => [l.id, l.name || "Level TBC"]));
  const pointsFor = (n: ScanNode, cv: Canvas): Points => {
    const list = (pointsOf.get(n.id) ?? []).slice().sort((a, b) => natural(headOf(a), headOf(b)) || byNameId(a, b));
    const byType = new Map<string, number>(POINT_TYPES.map((t) => [t, 0]));
    let tbc = 0;
    for (const p of list) {
      const t = text(param(p.params, "point_type").value)?.toUpperCase() ?? null;
      if (t === null) tbc++;
      else byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    if (tbc) cv.tbc.add(`${headOf(n)} points`, "point type", tbc);
    return { list, byType, tbc };
  };
  const typeLine = (p: Points) => {
    const extra = [...p.byType.keys()].filter((t) => !POINT_TYPES.includes(t)).sort(natural);
    const parts = [...POINT_TYPES, ...extra].map((t) => `${t} ${p.byType.get(t) ?? 0}`);
    if (p.tbc) parts.push(`type TBC ${p.tbc}`);
    return `Points ${p.list.length}: ${parts.join(" · ")}`;
  };

  // ---- riser: measure each placed node's column
  interface Grp { mark: Mark; nodes: ScanNode[]; text: string; w: number; h: number }
  interface Col { n: ScanNode; mark: Mark; symW: number; symH: number; head: string; body: string; blockW: number; blockH: number;
    groups: Grp[]; rowW: number; rowH: number; link: string | null; linkW: number; slot: number }
  const cols = new Map<string, Col>();
  for (const n of placed) {
    const mark = symbolFor(n, d.kind, kit);
    const [symW, symH] = c.markSize(mark);
    const head = headOf(n);
    const p = pointsFor(n, c);
    const lines = [`Protocol: ${c.tbc.value(param(n.params, "protocol").value, head, "protocol")}`,
      p.list.length ? typeLine(p) : "Points: none in the model"];
    if (p.list.length) lines.push(`See ${pointsName}`);
    const body = lines.join("\n");
    const groups = new Map<string, Grp>();
    for (const pt of p.list) {
      const m = symbolFor(pt, d.kind, kit);
      const key = m.t === "symbol" ? `${m.family}:${m.type}` : `box|${m.label}`;
      const g = groups.get(key) ?? groups.set(key, { mark: m, nodes: [], text: "", w: 0, h: 0 }).get(key)!;
      g.nodes.push(pt);
    }
    const grps = [...groups.values()].sort((a, b) => natural(a.mark.label, b.mark.label));
    for (const g of grps) {
      const [w, h] = c.markSize(g.mark);
      g.text = `×${g.nodes.length}${g.mark.t === "box" ? ` ${g.mark.label}` : ""}`;
      g.w = w; g.h = h;
    }
    const rowW = grps.reduce((s, g) => s + g.w + 2 + c.measure(g.text).w + 5, 0);
    const rowH = Math.max(0, ...grps.map((g) => g.h));
    const e = parent.get(n.id);
    let link: string | null = null;
    if (e) {
      const pr = text(param(e.params, "protocol").value) ?? text(param(n.params, "protocol").value);
      if (!pr) c.tbc.add(`${head} link to ${headOf(byId.get(e.from)!)}`, "protocol");
      link = pr ?? "Protocol TBC";
    }
    const blockW = Math.max(c.measure(head, c.title).w, c.measure(body).w);
    const blockH = c.blockH(1, c.title) + 2 + c.blockH(lines.length);
    cols.set(n.id, { n, mark, symW, symH, head, body, blockW, blockH, groups: grps, rowW, rowH, link,
      linkW: link ? c.measure(link).w : 0, slot: c.up(10 + symW / 2 + 3 + Math.max(blockW, rowW) + 10) });
  }

  // ---- bands
  const bandOf = new Map<string, string>();
  for (const n of placed) {
    const ok = !!n.level && levels.some((l) => l.id === n.level);
    bandOf.set(n.id, ok ? n.level! : "__none");
    if (!ok) c.tbc.add(headOf(n), "level");
  }
  const bands = levels.slice().sort((a, b) => b.elevation_mm - a.elevation_mm || natural(a.name, b.name) || a.id.localeCompare(b.id))
    .map((l) => ({ id: l.id, title: `${l.name || "Level TBC"}\n${l.elevation_mm >= 0 ? "+" : ""}${(l.elevation_mm / 1000).toFixed(3)}` }));
  if ([...bandOf.values()].includes("__none")) bands.push({ id: "__none", title: "No level" });
  const baseTitle = "Supervisory (head end)";
  const LW = c.up(Math.max(0, ...bands.map((b) => c.measure(b.title).w), base.length ? c.measure(baseTitle).w : 0) + 10);

  const colX = new Map<string, number>();
  let x = LW;
  for (const n of placed) { colX.set(n.id, x + 10); x += cols.get(n.id)!.slot; }
  let totalW = c.up(x);
  const th1 = c.blockH(1);
  const symBottom = new Map<string, number>();
  let yT = 0;
  const bandTops: number[] = [];
  for (const band of bands) {
    bandTops.push(yT);
    let bottom = yT - kit.layout.band_min_height_mm;
    const here = placed.filter((n) => bandOf.get(n.id) === band.id);
    const cy = yT - 10;
    for (const n of here) {
      const col = cols.get(n.id)!;
      const sx = colX.get(n.id)!;
      c.mark(col.mark, sx, cy, n.id);
      const tx = sx + col.symW / 2 + 3;
      c.text(tx, yT - 5, col.head, { style: c.title, source: n.id });
      c.text(tx, yT - 5 - c.blockH(1, c.title) - 2, col.body, { source: n.id });
      let content = Math.min(yT - 5 - col.blockH, cy - col.symH / 2);
      if (col.groups.length) {
        const ry = c.down(yT - 5 - col.blockH - 3 - col.rowH / 2);
        let rx = tx;
        for (const g of col.groups) {
          const ids = g.nodes.map((p) => p.id);
          c.mark(g.mark, rx + g.w / 2, ry, ids[0]);
          for (const id of ids) c.covered.add(id);
          c.text(rx + g.w + 2, ry + th1 / 2, g.text);
          rx += g.w + 2 + c.measure(g.text).w + 5;
        }
        content = Math.min(content, ry - Math.max(col.rowH, th1) / 2);
      }
      const sb = cy - col.symH / 2;
      symBottom.set(n.id, sb);
      bottom = Math.min(bottom, content - 5, col.link ? sb - col.linkW - 6 : bottom);
    }
    bottom = c.down(bottom);
    // the link's protocol beside its drop, under the symbol
    for (const n of here) {
      const col = cols.get(n.id)!;
      if (!col.link) continue;
      c.text(colX.get(n.id)! - 1.5 - th1, (symBottom.get(n.id)! + bottom) / 2, col.link, { align: "center", rotation: 90, source: parent.get(n.id)!.id ?? null });
    }
    c.text(0, yT - 2, band.title);
    yT = bottom;
  }
  const lastBottom = yT;

  // ---- base row: supervisors, each with a track the nodes under it come down to
  const track = new Map<string, number>();
  const baseX = new Map<string, number>();
  if (base.length) {
    base.forEach((b, k) => track.set(b.id, c.down(lastBottom - 5) - 5 * k));
    const yB = Math.min(...track.values()) - 5;
    const marks = base.map((b) => symbolFor(b, d.kind, kit));
    const hmax = Math.max(6, ...marks.map((m) => c.markSize(m)[1]));
    const cy = c.down(yB - 2.5 - hmax / 2);
    const labelTop = cy - hmax / 2 - 1.5;
    c.text(0, yB - 2, baseTitle);
    let sx = LW + 10;
    base.forEach((b, i) => {
      const head = headOf(b);
      const lv = b.level ? levelName.get(b.level) ?? null : null;
      if (!lv) c.tbc.add(head, "level");
      const pr = text(param(b.params, "protocol").value);
      if (!pr) c.tbc.add(head, "protocol");
      const p = pointsFor(b, c);
      const lines = [head, `Level: ${lv ?? "TBC"}`, pr ? `${pr} backbone` : "Backbone protocol TBC"];
      if (p.list.length) {
        lines.push(typeLine(p), `See ${pointsName}`);
        for (const pt of p.list) c.covered.add(pt.id);
      }
      const label = lines.join("\n");
      const size = c.markSize(marks[i]);
      const w = c.up(Math.max(size[0], c.measure(label).w)) + 10;
      const px = c.snap(sx + (w - 5) / 2);
      baseX.set(b.id, px);
      c.mark(marks[i], px, cy, b.id);
      c.text(px, labelTop, label, { align: "center", source: b.id });
      const up = Math.max(track.get(b.id)!, parent.has(b.id) ? track.get(parent.get(b.id)!.from) ?? -Infinity : -Infinity);
      c.line([[px, cy + size[1] / 2], [px, up]], L.medium, b.id);
      sx += w;
    });
    totalW = Math.max(totalW, c.up(sx));
  }
  // drops from placed nodes to their supervisor's track, and each track's run
  for (const n of placed) {
    const e = parent.get(n.id);
    if (!e || !track.has(e.from)) continue;
    c.line([[colX.get(n.id)!, symBottom.get(n.id)!], [colX.get(n.id)!, track.get(e.from)!]], L.medium, e.id ?? n.id);
  }
  for (const b of base) {
    const xs = [baseX.get(b.id)!, ...(kids.get(b.id) ?? []).map((k) => colX.get(k.id) ?? baseX.get(k.id)!)];
    c.line([[Math.min(...xs), track.get(b.id)!], [Math.max(...xs), track.get(b.id)!]], L.medium, b.id);
  }
  for (const y of bandTops) c.line([[0, y], [totalW, y]], L.thin);
  c.line([[0, lastBottom], [totalW, lastBottom]], L.thin);

  // ---- what the model doesn't tie together: listed, never guessed
  const loose = nodes.filter((n) => !isNet(n) && !owner.has(n.id));
  const noId = loose.filter((n) => text(param(n.params, "controller_id").value) === null);
  if (noId.length) c.note(`Points with no FMC_Controller_ID (${noId.length}): ${list(noId.map(headOf))}.`);
  const unknown = new Map<string, ScanNode[]>();
  for (const n of loose) {
    const id = text(param(n.params, "controller_id").value);
    if (id !== null) (unknown.get(id) ?? unknown.set(id, []).get(id)!).push(n);
  }
  for (const id of [...unknown.keys()].sort(natural))
    c.note(`FMC_Controller_ID "${id}" matches no controller in the model (${unknown.get(id)!.length}): ${list(unknown.get(id)!.map(headOf))}.`);
  for (const n of loose) c.covered.add(n.id);
  const lone = placed.filter((n) => !parent.has(n.id));
  if (lone.length && base.length) c.note(`Not on a supervisory network in the model: ${list(lone.map(headOf))}.`);
  if (placed.length && !base.length)
    c.note("No head end or supervisory controller in the model: a controller's FMC_Controller_ID names its supervisor.");
  for (const l of loops) c.note(`The controller links between ${l} make a loop: the second link is not drawn.`);
  if (!nodes.length) c.note("Nothing in the model for this diagram yet.");
  c.note(`Points per controller are listed on ${pointsName}.`);

  const riser: Page = { name: riserName, canvas: c, system: d.system, title };

  // ---- points list
  const t = new Canvas(kit);
  let y = 0;
  const max = Math.max(0, Math.floor(kit.layout.controls_points_max));
  for (const n of order) {
    const p = pointsFor(n, t);
    if (!p.list.length) continue;
    const head = headOf(n);
    const pr = t.tbc.value(param(n.params, "protocol").value, head, "protocol", "", "protocol TBC");
    t.text(0, y, `${head} · ${pr} · ${p.list.length} point${p.list.length === 1 ? "" : "s"}`, { style: t.title, source: n.id });
    const top = y - t.blockH(1, t.title) - 2;
    for (const pt of p.list) t.covered.add(pt.id);
    if (p.list.length <= max) {
      const rows = p.list.map((pt) => {
        const subject = pt.name || pt.family || pt.id;
        return [t.tbc.value(param(pt.params, "mark").value, subject, "mark"), pt.name || pt.family || pt.kind,
          t.tbc.value(param(pt.params, "point_type").value, subject, "point type").toUpperCase(),
          t.tbc.value(param(pt.params, "signal").value, subject, "signal")];
      });
      const heads = ["Mark", "Device", "Point", "Signal"];
      let cx = 0;
      heads.forEach((h, i) => {
        const body = [h, ...rows.map((r) => r[i])].join("\n");
        t.text(cx, top, body);
        cx += t.up(t.measure(body).w + 5);
      });
      y = top - t.blockH(rows.length + 1) - 10;
    } else {
      const body = `${typeLine(p)}\nMore than ${max} points: see ${kit.layout.controls_points_schedule}`;
      t.text(0, top, body);
      y = top - t.blockH(2) - 10;
    }
  }
  if (!t.items.length) t.note("No controller has points in the model yet.");
  const points: Page = { name: pointsName, canvas: t, system: d.system, title: `Controls points list${d.system ? `: ${d.system}` : ""}` };
  return [riser, points];
}
