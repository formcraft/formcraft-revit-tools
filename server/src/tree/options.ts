/**
 * Options side by side (docs/PLAN_OPTIONS.md, O1): every variant of a node measured from its recipes, without Revit.
 * Area against the brief, quantities (wall and ceiling area, doors, windows, each family type), each room's own checks,
 * and a daylight proxy (glazing over floor area, only where the recipe gives the window's height). Cost is compared as
 * quantities only (owner's decision, 19 October 2026). The result is trade-offs, never a ranking: nothing here chooses.
 * Also a plan sketch per variant (SVG drawn from the ops), the same view for each. Pure.
 */
import { Op, ROOM, planRoom } from "./room.js";
import { Tree, TreeNode, findNode, resolve } from "./tree.js";

export interface Measures {
  variant: string; name: string;
  rooms: number; area_m2: number; target_m2: number; off_target: string[];
  walls_m2: number; ceilings_m2: number; doors: number; windows: number;
  glazing_m2: number | null; daylight_pct: number | null; daylight_note?: string;
  families: Record<string, number>;
  problems: string[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

/** The tree with this node's active variant set (null: the node as it is, without a variant). A copy: the tree is untouched. */
export function withActive(tree: Tree, nodeId: string, variant: string | null): Tree {
  const t: Tree = JSON.parse(JSON.stringify(tree));
  const n = findNode(t, nodeId);
  if (!n) throw new Error(`No node ${nodeId}`);
  if (variant === null) delete n.active;
  else {
    if (!n.variants?.some((v) => v.id === variant)) throw new Error(`${nodeId} has no variant ${variant}`);
    n.active = variant;
  }
  return t;
}

/** The rooms a node makes (itself or under it), planned. */
function roomsUnder(tree: Tree, nodeId: string) {
  const kindOf = (id: string) => findNode(tree, id)?.kind;
  return resolve(tree).filter((r) => r.node.make?.tool === "fmc_room" && r.path.includes(nodeId) && !r.path.some((id) => kindOf(id) === "library"));
}

export function measure(tree: Tree, nodeId: string, variant: string, name: string, tolerancePct = 10): Measures {
  const m: Measures = { variant, name, rooms: 0, area_m2: 0, target_m2: 0, off_target: [], walls_m2: 0, ceilings_m2: 0, doors: 0, windows: 0,
    glazing_m2: 0, daylight_pct: null, families: {}, problems: [] };
  let glazingKnown = true;
  for (const r of roomsUnder(tree, nodeId)) {
    if (r.error) { m.problems.push(`${r.node.id}: ${r.error}`); continue; }
    const parsed = ROOM.safeParse((r.args as any)?.room);
    if (!parsed.success) { m.problems.push(`${r.node.id}: ${parsed.error.issues[0]?.message}`); continue; }
    const room = parsed.data, plan = planRoom(room);
    m.problems.push(...plan.problems.map((p) => `${room.number ?? r.node.id}: ${p}`));
    m.rooms++;
    const area = (room.width * room.depth) / 1e6;
    m.area_m2 += area;
    const target = num(room.params.FMC_Target_Area);
    if (target) {
      m.target_m2 += target;
      const off = ((area - target) / target) * 100;
      if (Math.abs(off) > tolerancePct) m.off_target.push(`${room.number ?? ""} ${room.name}: ${r2(area)} m² for ${target} (${off > 0 ? "+" : ""}${Math.round(off)}%)`.trim());
    }
    for (const o of plan.ops) {
      if (o.op === "wall") m.walls_m2 += (Math.hypot(o.end[0] - o.start[0], o.end[1] - o.start[1]) * o.height) / 1e6;
      if (o.op === "ceiling") m.ceilings_m2 += area;
      if (o.op === "opening") {
        if (o.kind === "door") m.doors++;
        else {
          m.windows++;
          if (o.width && o.height) m.glazing_m2! += (o.width * o.height) / 1e6; else glazingKnown = false;
        }
      }
      if (o.op === "opening" || o.op === "place") { const k = `${o.family} : ${o.type}`; m.families[k] = (m.families[k] ?? 0) + 1; }
    }
  }
  m.area_m2 = r2(m.area_m2); m.target_m2 = r2(m.target_m2); m.walls_m2 = r2(m.walls_m2); m.ceilings_m2 = r2(m.ceilings_m2);
  if (!m.windows) { m.glazing_m2 = 0; m.daylight_pct = 0; m.daylight_note = "no windows"; }
  else if (!glazingKnown) { m.glazing_m2 = null; m.daylight_note = "a window's height isn't in the recipe: no proxy"; }
  else { m.glazing_m2 = r2(m.glazing_m2!); m.daylight_pct = m.area_m2 ? Math.round((m.glazing_m2 / m.area_m2) * 1000) / 10 : null; m.daylight_note = "glazing over floor area: a proxy, not a simulation"; }
  return m;
}

export interface Comparison { node: string; options: Measures[]; differs: string[] }

/** The node as it is, and each of its variants, measured the same way. */
export function compareOptions(tree: Tree, nodeId: string, tolerancePct = 10): Comparison {
  const n = findNode(tree, nodeId);
  if (!n) throw new Error(`No node ${nodeId}`);
  const options = [measure(withActive(tree, nodeId, null), nodeId, "base", n.name ?? "As it is", tolerancePct),
    ...(n.variants ?? []).map((v) => measure(withActive(tree, nodeId, v.id), nodeId, v.id, v.name ?? v.id, tolerancePct))];
  const keys: Array<keyof Measures> = ["rooms", "area_m2", "walls_m2", "ceilings_m2", "doors", "windows", "glazing_m2", "daylight_pct"];
  const differs = keys.filter((k) => new Set(options.map((o) => JSON.stringify(o[k]))).size > 1) as string[];
  if (new Set(options.map((o) => JSON.stringify(o.families))).size > 1) differs.push("families");
  return { node: nodeId, options, differs };
}

/** The comparison as a one-page sheet (Markdown): the same rows for every option, the differences marked. */
export function optionSheet(c: Comparison, title: string): string {
  const rows: Array<[string, (m: Measures) => string]> = [
    ["Rooms", (m) => String(m.rooms)], ["Area (m²)", (m) => String(m.area_m2)], ["Brief (m²)", (m) => String(m.target_m2)],
    ["Off the brief", (m) => m.off_target.length ? m.off_target.join("; ") : "none"],
    ["Walls (m²)", (m) => String(m.walls_m2)], ["Ceilings (m²)", (m) => String(m.ceilings_m2)], ["Doors", (m) => String(m.doors)], ["Windows", (m) => String(m.windows)],
    ["Daylight proxy (%)", (m) => (m.daylight_pct === null ? `n/a (${m.daylight_note})` : String(m.daylight_pct))],
    ["Checks", (m) => (m.problems.length ? m.problems.join("; ") : "pass")],
  ];
  const head = `| | ${c.options.map((o) => `**${o.name}** (${o.variant})`).join(" | ")} |\n|---|${c.options.map(() => "---").join("|")}|\n`;
  const body = rows.map(([k, f]) => `| ${k} | ${c.options.map(f).join(" | ")} |`).join("\n");
  const fams = [...new Set(c.options.flatMap((o) => Object.keys(o.families)))].sort()
    .map((k) => `| ${k} | ${c.options.map((o) => o.families[k] ?? 0).join(" | ")} |`).join("\n");
  return `# Options: ${title}\n\nQuantities only (no rates). The daylight figure is a proxy. These are trade-offs for a person to weigh: nothing is ranked.\n\n` +
    head + body + (fams ? `\n\n## Families\n\n| Family : type | ${c.options.map((o) => o.name).join(" | ")} |\n|---|${c.options.map(() => "---").join("|")}|\n${fams}` : "") +
    `\n\nDiffers in: ${c.differs.join(", ") || "nothing"}.\n`;
}

/** A plan sketch of what a node makes (SVG, north up, mm): walls, doors and windows, items. The same scale for every variant. */
export function planSvg(tree: Tree, nodeId: string): string {
  const ops: Op[] = [];
  for (const r of roomsUnder(tree, nodeId)) {
    const p = ROOM.safeParse((r.args as any)?.room);
    if (p.success) ops.push(...planRoom(p.data).ops);
  }
  const pts = ops.flatMap((o) => (o.op === "wall" ? [o.start, o.end] : o.op === "ceiling" ? o.outline : "at" in o ? [o.at] : []));
  if (!pts.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>`;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = 500, x0 = Math.min(...xs) - pad, y1 = Math.max(...ys) + pad, w = Math.max(...xs) - x0 + pad, h = y1 - Math.min(...ys) + pad;
  const X = (x: number) => Math.round(x - x0), Y = (y: number) => Math.round(y1 - y);
  const el: string[] = [];
  for (const o of ops) {
    if (o.op === "wall") el.push(`<line x1="${X(o.start[0])}" y1="${Y(o.start[1])}" x2="${X(o.end[0])}" y2="${Y(o.end[1])}" stroke="#222" stroke-width="200" stroke-linecap="square"/>`);
    if (o.op === "opening") el.push(`<circle cx="${X(o.at[0])}" cy="${Y(o.at[1])}" r="${(o.width ?? 900) / 2}" fill="none" stroke="${o.kind === "door" ? "#c33" : "#39c"}" stroke-width="40"/>`);
    if (o.op === "place") el.push(`<rect x="${X(o.at[0]) - 150}" y="${Y(o.at[1]) - 150}" width="300" height="300" fill="#7a5"/><text x="${X(o.at[0]) + 200}" y="${Y(o.at[1])}" font-size="250" fill="#333">${o.id.replace(/[<&>]/g, "")}</text>`);
    if (o.op === "room") el.push(`<text x="${X(o.at[0])}" y="${Y(o.at[1])}" font-size="300" text-anchor="middle" fill="#555">${`${o.number ?? ""} ${o.name}`.trim().replace(/[<&>]/g, "")}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}" width="${Math.round(w / 20)}" height="${Math.round(h / 20)}"><rect width="100%" height="100%" fill="#fff"/>${el.join("")}</svg>`;
}

/** A new variant of a node: inputs that differ (sizes, a layout, a template). */
export function addVariant(node: TreeNode, v: { id: string; name?: string; note?: string; inputs?: Record<string, unknown> }) {
  if ((node.variants ?? []).some((x) => x.id === v.id)) throw new Error(`${node.id} has a variant ${v.id} already`);
  node.variants = [...(node.variants ?? []), { id: v.id, ...(v.name ? { name: v.name } : {}), ...(v.note ? { note: v.note } : {}), inputs: v.inputs ?? {} }];
}
