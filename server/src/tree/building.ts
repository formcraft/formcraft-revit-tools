/**
 * The building from its brief (docs/PLAN_RECIPE_TREE.md, T5): the approved Concept Information Set (fmc-cis) becomes one
 * recipe tree. Levels from the CIS levels (each level's structure height is the step to the next); on each level, one
 * department per FMC_Department, laid out as a corridor with its rooms (T4); each room copied from a template room in
 * the tree's library (a node kind that is never built), carrying its number, name and programme data (FMC_Target_Area,
 * FMC_Finish_Set…) into the Revit room. A room's width comes from its target area and its template's depth, and the plan
 * says so: the brief gives areas, not shapes, so every derived size is shown to the person before anything is built.
 * Quantities and checks run across the whole tree: planned against target area, per room, department and level. Pure.
 */
import type { Cis, CisRoom } from "../fmc/brief.js";
import { applyLayout, layoutDepartment, Department } from "./department.js";
import { ROOM, planRoom } from "./room.js";
import { ICU_BAY_SAMPLE } from "./samples.js";
import { Tree, TreeNode, findNode, resolve } from "./tree.js";

export interface BriefOptions {
  /** The project template's types (the tree's root inputs; never guessed). */
  wall_type: string; wall_thickness: number; ceiling_type: string; ceiling_height: number;
  corridor_width: number;
  /** Room number prefix → level name, for rooms whose CIS entry names no level (e.g. { "G": "00 Ground Floor", "1": "01 First Floor" }). */
  level_prefixes?: Record<string, string>;
  /** First match wins: a room's name or department matching `match` (case-insensitive) uses that template. */
  templates?: Array<{ match: string; template: string }>;
  default_template?: string;
  /** The top level's structure height, when rooms sit on the highest level of the CIS. */
  top_structure_height?: number;
}

export interface BriefTree {
  tree: Tree;
  /** Each room's size and where it came from, for the person to see first. */
  sizes: Array<{ number: string; level: string; department: string; template: string; size: number[]; from: string }>;
  problems: string[];
  warnings: string[];
}

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "X";
const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null);

/** The library a new tree starts with: a plain room (a door on its corridor wall) and the ICU bay from the sample. */
export function defaultLibrary(): TreeNode {
  const icu = findNode(ICU_BAY_SAMPLE, "ICU-Bay-01")!;
  const rename = (n: TreeNode, from: string, to: string): TreeNode => ({ ...JSON.parse(JSON.stringify(n)), id: n.id.replace(from, to),
    ...(n.children ? { children: n.children.filter((c) => c.kind !== "group").map((c) => rename(c, from, to)) } : {}) });
  const bay = rename(icu, "ICU-Bay-01", "Library.ICU-Bay");
  bay.inputs = { ...bay.inputs, name: "ICU bay", params: {} };
  return {
    id: "Library", kind: "library", name: "Template rooms (copied into the building, never built themselves)",
    inputs: { level: "(template)", structure_height: 3300 },
    children: [
      { id: "Library.Plain", kind: "room", name: "Plain room: walls, a door on the corridor wall, a ceiling",
        inputs: { name: "Room", number: "T-01", width: 3000, depth: 3000, origin: [0, 0], skip_walls: [], corridor_wall: "south", head_wall: "north", params: {} },
        children: [{ id: "Library.Plain.Room", kind: "assembly", name: "The room",
          make: { tool: "fmc_room", args: { action: "build", room: {
            name: "${var.name}", number: "${var.number}", level: "${var.level}", origin_mm: "${var.origin}",
            width: "${var.width}", depth: "${var.depth}", height: "${var.structure_height}",
            walls: { type: "${var.wall_type}", thickness: "${var.wall_thickness}", skip: "${var.skip_walls}" },
            ceiling: { type: "${var.ceiling_type}", height: "${var.ceiling_height}" }, params: "${var.params}",
            openings: [{ kind: "door", family: "FMC_A_Door_FlushSingle_Hygienic_Detailed", type: "1026x2100_S", wall: "${var.corridor_wall}", along: 700, width: 1026 }],
            items: [],
          } } } }] },
      bay,
    ],
  };
}

/** The families the library's templates use: loaded once, at the top of the tree. */
function familiesNode(): TreeNode {
  const g = findNode(ICU_BAY_SAMPLE, "ICU-Bay-01.Families")!;
  const c: TreeNode = JSON.parse(JSON.stringify(g));
  c.id = "Families";
  c.children = (c.children ?? []).map((k) => ({ ...k, id: k.id.replace("ICU-Bay-01.", "Families.") }));
  return c;
}

const MIN_WIDTH = 1500; // the plain room's door (1026) with its returns needs about this much wall

export function treeFromBrief(cis: Cis, o: BriefOptions): BriefTree {
  const problems: string[] = [], warnings: string[] = [], sizes: BriefTree["sizes"] = [];
  const library = defaultLibrary();
  const libTree: Tree = { schema: "fmc-tree/0.1", project: cis.project, root: library };
  const templateOf = (r: CisRoom, dept: string) => (o.templates ?? []).find((t) => new RegExp(t.match, "i").test(r.name) || new RegExp(t.match, "i").test(dept))?.template
    ?? o.default_template ?? "Library.Plain";
  const levels = [...cis.levels].sort((a, b) => a.elevation_mm - b.elevation_mm);
  const levelOf = (r: CisRoom): string | null => {
    if (r.level) return levels.some((l) => l.name === r.level) ? r.level : null;
    const p = Object.keys(o.level_prefixes ?? {}).filter((k) => r.number.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return p ? o.level_prefixes![p] : null;
  };
  // rooms by level, then by department, in the brief's order
  const byLevel = new Map<string, Map<string, CisRoom[]>>();
  for (const r of cis.rooms) {
    const lv = levelOf(r);
    if (!lv) { problems.push(`${r.number} ${r.name}: no level (give it a level in the CIS, or a number prefix in level_prefixes)`); continue; }
    if (!levels.some((l) => l.name === lv)) { problems.push(`${r.number}: level ${lv} isn't in the CIS levels`); continue; }
    const dept = String(r.params.FMC_Department ?? "").trim();
    if (!dept) warnings.push(`${r.number} ${r.name}: no FMC_Department; placed in "Unassigned"`);
    const d = dept || "Unassigned";
    if (!byLevel.has(lv)) byLevel.set(lv, new Map());
    const m = byLevel.get(lv)!;
    m.set(d, [...(m.get(d) ?? []), r]);
  }
  const t = o.wall_thickness;
  const levelNodes: TreeNode[] = [];
  for (const [i, lv] of levels.entries()) {
    const depts = byLevel.get(lv.name);
    if (!depts) continue;
    const above = levels[i + 1];
    const structure_height = above ? above.elevation_mm - lv.elevation_mm : o.top_structure_height;
    if (!structure_height) { problems.push(`${lv.name} has rooms and no level above it: give top_structure_height`); continue; }
    if (structure_height <= o.ceiling_height) problems.push(`${lv.name}: the ceiling (${o.ceiling_height}) is at or above the structure (${structure_height})`);
    const levelNode: TreeNode = { id: `L-${slug(lv.name)}`, kind: "level", name: lv.name, inputs: { level: lv.name, structure_height }, children: [] };
    let y = 0;
    let prevNorth = 0;
    for (const [dept, rooms] of depts) {
      // each room's size: from its target area and its template's depth; the template's size when there is no area
      const rows: { north: Department["north"]; south: Department["south"] } = { north: [], south: [] };
      const len = { north: 0, south: 0 };
      for (const r of rooms) {
        const tid = templateOf(r, dept);
        const tpl = findNode(libTree, tid);
        if (!tpl) { problems.push(`${r.number}: no template ${tid} in the library`); continue; }
        const tplDepth = num(tpl.inputs?.depth) ?? 3000;
        const area = num(r.params.FMC_Target_Area);
        let width = num(tpl.inputs?.width) ?? 3000, depth = tplDepth, from = `the template ${tid}`;
        if (area) {
          // the template's depth, deeper when the room would be longer than 1.5 : 1 along the corridor
          depth = Math.max(tplDepth, Math.round(Math.sqrt((area * 1e6) / 1.5) / 100) * 100);
          width = Math.max(MIN_WIDTH, Math.ceil((area * 1e6) / depth / 100) * 100);
          from = `${area} m² over ${depth > tplDepth ? `${depth} mm depth (deeper than the template's ${tplDepth}, to stay within 1.5 : 1)` : `the template's ${depth} mm depth`}` +
            `${width * depth / 1e6 - area > area * 0.15 ? ` (at least ${MIN_WIDTH} wide for its door)` : ""}`;
        }
        // the shorter row takes the next room, so the corridor stays short
        const side = len.north <= len.south ? "north" : "south";
        rows[side].push({ id: slug(r.number), name: r.name, number: r.number, width, depth, template: tid,
          params: Object.fromEntries(Object.entries(r.params).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number> });
        len[side] += width + t;
        sizes.push({ number: r.number, level: lv.name, department: dept, template: tid, size: [width, depth], from });
      }
      const southDepth = Math.max(0, ...rows.south.map((r) => r.depth));
      // departments one after another northwards, back to back: each builds its own outer walls
      // (the last one's top inner face and this one's bottom inner face two wall thicknesses apart: two walls touching)
      if (levelNode.children!.length) y += prevNorth + 4 * t + southDepth;
      const layout = { origin_mm: [0, y], wall_thickness: t, corridor: { width: o.corridor_width, name: `${dept} corridor` }, north: rows.north, south: rows.south };
      prevNorth = o.corridor_width + Math.max(0, ...rows.north.map((r) => r.depth));
      const deptNode: TreeNode = { id: `${levelNode.id}.${slug(dept)}`, kind: "department", name: dept, inputs: { layout, template: o.default_template ?? "Library.Plain" } };
      const laid = layoutDepartment(layout as Department);
      problems.push(...laid.problems.map((p) => `${lv.name} ${dept}: ${p}`));
      warnings.push(...laid.warnings.map((w) => `${lv.name} ${dept}: ${w}`));
      const made = applyLayout(deptNode, laid, (id) => findNode(libTree, id), o.default_template ?? "Library.Plain");
      problems.push(...made.problems);
      deptNode.children = made.children;
      levelNode.children!.push(deptNode);
    }
    levelNodes.push(levelNode);
  }
  const tree: Tree = {
    schema: "fmc-tree/0.1", project: cis.project,
    root: { id: slug(cis.project) || "Project", kind: "project", name: `${cis.project} ${cis.revision}`.trim(),
      inputs: { wall_type: o.wall_type, wall_thickness: o.wall_thickness, ceiling_type: o.ceiling_type, ceiling_height: o.ceiling_height, cis_revision: cis.revision },
      children: [familiesNode(), library, ...levelNodes] },
  };
  return { tree, sizes, problems, warnings };
}

export interface QuantityRow {
  node: string; level: string; department: string; number: string; name: string;
  area_m2: number; target_m2: number | null; off_pct: number | null; walls_m: number; doors: number; windows: number; items: number;
}

/** Quantities and checks across the tree: every room a room build makes (the library's templates left out). */
export function treeQuantities(tree: Tree, tolerancePct = 10) {
  const rows: QuantityRow[] = [];
  const problems: string[] = [];
  const kindOf = (id: string) => findNode(tree, id)?.kind;
  for (const r of resolve(tree)) {
    if (r.node.make?.tool !== "fmc_room" || r.path.some((id) => kindOf(id) === "library")) continue;
    if (r.error) { problems.push(`${r.path.join(" › ")}: ${r.error}`); continue; }
    const parsed = ROOM.safeParse((r.args as any)?.room);
    if (!parsed.success) { problems.push(`${r.node.id}: ${parsed.error.issues[0]?.message}`); continue; }
    const room = parsed.data, plan = planRoom(room);
    problems.push(...plan.problems.map((p) => `${r.node.id}: ${p}`));
    const levelId = r.path.find((id) => kindOf(id) === "level"), deptId = r.path.find((id) => kindOf(id) === "department");
    const area = Math.round((room.width * room.depth) / 1e4) / 100;
    const target = num(room.params.FMC_Target_Area);
    const walls = plan.ops.filter((o) => o.op === "wall").reduce((s, o: any) => s + Math.hypot(o.end[0] - o.start[0], o.end[1] - o.start[1]), 0);
    rows.push({ node: r.node.id, level: findNode(tree, levelId ?? "")?.name ?? levelId ?? "", department: findNode(tree, deptId ?? "")?.name ?? deptId ?? "",
      number: room.number ?? "", name: room.name, area_m2: area, target_m2: target, off_pct: target ? Math.round(((area - target) / target) * 1000) / 10 : null,
      walls_m: Math.round(walls / 100) / 10, doors: plan.ops.filter((o) => o.op === "opening" && o.kind === "door").length,
      windows: plan.ops.filter((o) => o.op === "opening" && o.kind === "window").length, items: plan.ops.filter((o) => o.op === "place").length });
  }
  const sum = (xs: QuantityRow[]) => ({ rooms: xs.length, area_m2: Math.round(xs.reduce((s, x) => s + x.area_m2, 0) * 100) / 100,
    target_m2: Math.round(xs.reduce((s, x) => s + (x.target_m2 ?? 0), 0) * 100) / 100, walls_m: Math.round(xs.reduce((s, x) => s + x.walls_m, 0) * 10) / 10,
    doors: xs.reduce((s, x) => s + x.doors, 0), windows: xs.reduce((s, x) => s + x.windows, 0) });
  const group = (key: (x: QuantityRow) => string) => Object.fromEntries([...new Set(rows.map(key))].map((k) => [k, sum(rows.filter((x) => key(x) === k))]));
  const off = rows.filter((x) => x.off_pct !== null && Math.abs(x.off_pct) > tolerancePct)
    .map((x) => `${x.number} ${x.name}: ${x.area_m2} m² planned, ${x.target_m2} m² in the brief (${x.off_pct! > 0 ? "+" : ""}${x.off_pct}%)`);
  return { rows, by_level: group((x) => x.level), by_department: group((x) => `${x.level} › ${x.department}`), total: sum(rows), off_target: off, problems };
}
