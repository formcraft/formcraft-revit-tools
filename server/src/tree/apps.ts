/**
 * Every app from the tree (docs/PLAN_RECIPE_TREE.md, T6). The tree already knows every room, its department and level,
 * and every element a room build makes carries the tree's mark in its Revit Comments (FMC:<node>). From that:
 *   Navisworks: a search set per room, and per department and level, that finds the room's items by that mark, so the
 *               sets follow the rooms through every rebuild (clash tests by department, viewpoints per room);
 *   Power BI:   the tree's quantities as tidy CSV (one row per room, and per level and department), in an exchange
 *               package, so a dashboard refreshes from the latest package.
 * Pure: the tool sends the sets through the Navisworks bridge and writes the package.
 */
import { csvLine } from "../fmc/policy.js";
import { treeQuantities } from "./building.js";
import { Tree, findNode, resolve } from "./tree.js";

export interface SearchSetSpec { path: string[]; name: string; contains: string }

/** The search sets for the tree's rooms: Level › Department › each room, and an "All of …" set per level and department. */
export function treeSearchSets(tree: Tree): SearchSetSpec[] {
  const out: SearchSetSpec[] = [];
  const seen = new Set<string>();
  const kindOf = (id: string) => findNode(tree, id)?.kind;
  for (const r of resolve(tree)) {
    if (r.node.make?.tool !== "fmc_room" || r.path.some((id) => kindOf(id) === "library") || r.error) continue;
    const levelId = r.path.find((id) => kindOf(id) === "level"), deptId = r.path.find((id) => kindOf(id) === "department");
    const level = levelId ? findNode(tree, levelId)!.name ?? levelId : "No level";
    const dept = deptId ? findNode(tree, deptId)!.name ?? deptId : "No department";
    const room = (r.args as any)?.room ?? {};
    // an "All of" set finds its rooms by their id's start: only where the rooms' ids nest under it (a tree made by brief)
    if (levelId && !seen.has(levelId) && r.node.id.startsWith(levelId + ".")) { seen.add(levelId); out.push({ path: [level], name: `All of ${level}`, contains: `FMC:${levelId}.` }); }
    if (deptId && !seen.has(deptId) && r.node.id.startsWith(deptId + ".")) { seen.add(deptId); out.push({ path: [level, dept], name: `All of ${dept}`, contains: `FMC:${deptId}.` }); }
    out.push({ path: [level, dept], name: `${room.number ? room.number + " " : ""}${room.name ?? r.node.id}`, contains: `FMC:${r.node.id}` });
  }
  return out;
}

/** The tree's quantities as Power BI's tidy CSV files. */
export function quantityCsv(tree: Tree, tolerancePct = 10): Array<{ name: string; text: string }> {
  const q = treeQuantities(tree, tolerancePct);
  const rooms = csvLine(["node", "level", "department", "number", "name", "area_m2", "target_m2", "off_pct", "walls_m", "doors", "windows", "items"]) +
    q.rows.map((x) => csvLine([x.node, x.level, x.department, x.number, x.name, x.area_m2, x.target_m2 ?? "", x.off_pct ?? "", x.walls_m, x.doors, x.windows, x.items])).join("");
  const groups = csvLine(["scope", "name", "rooms", "area_m2", "target_m2", "walls_m", "doors", "windows"]) +
    [["level", q.by_level], ["department", q.by_department], ["total", { Building: q.total }]].flatMap(([scope, g]) =>
      Object.entries(g as Record<string, ReturnType<typeof treeQuantities>["total"]>).map(([name, s]) => csvLine([scope as string, name, s.rooms, s.area_m2, s.target_m2, s.walls_m, s.doors, s.windows]))).join("");
  const checks = csvLine(["kind", "text"]) + [...q.off_target.map((t) => csvLine(["off_target", t])), ...q.problems.map((t) => csvLine(["problem", t]))].join("");
  return [{ name: "FMC_Tree_Rooms.csv", text: rooms }, { name: "FMC_Tree_Summary.csv", text: groups }, { name: "FMC_Tree_Checks.csv", text: checks }];
}
