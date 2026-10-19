import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLayout, layoutDepartment } from "./department.js";
import { ICU_BAY_SAMPLE } from "./samples.js";
import { TREE, Tree, findNode, planTree, recordBuilt, resolve, treeProblems } from "./tree.js";
import { ROOM, planRoom } from "./room.js";

const dept = (over: any = {}) => ({
  origin_mm: [0, 10000], wall_thickness: 200, corridor: { width: 2400 },
  north: [{ id: "Bay-01", width: 4200, depth: 5000 }, { id: "Bay-02", width: 4200, depth: 5000 }, { id: "Bay-03", width: 4200, depth: 5000 }],
  south: [{ id: "Store", width: 3000, depth: 3000, name: "Clean store" }, { id: "Bay-04", width: 4200, depth: 5000 }],
  ...over,
});

test("T4: rooms line the corridor; a shared wall is built by the room to its west; the corridor builds only its ends", () => {
  const l = layoutDepartment(dept());
  assert.deepEqual(l.problems, []);
  const by = Object.fromEntries(l.rooms.map((r) => [r.id, r]));
  assert.deepEqual(by["Bay-01"].origin, [0, 12600], "north of the corridor, a wall thickness past its inner face");
  assert.deepEqual(by["Bay-02"].origin, [4400, 12600]);
  assert.deepEqual(by["Bay-01"].skip, [], "the first room builds all four walls");
  assert.deepEqual(by["Bay-02"].skip, ["west"], "Bay-01's east wall is its west wall");
  assert.deepEqual(by["Store"].origin, [0, 6800], "south of the corridor: its north face a wall thickness below the corridor");
  assert.equal(by["Store"].corridor_wall, "north");
  assert.equal(by["Bay-01"].corridor_wall, "south");
  assert.equal(l.corridor.width, 13000, "as long as the longer row");
  assert.deepEqual(l.corridor.skip, ["north", "south"]);
  assert.match(l.warnings.join(), /south row stops 5600 mm short/);
});

test("T4: a row longer than the corridor, and a room id used twice, are problems", () => {
  assert.match(layoutDepartment(dept({ corridor: { width: 2400, length: 9000 } })).problems.join(), /north row is 13000 mm long, the corridor 9000/);
  assert.match(layoutDepartment(dept({ south: [{ id: "Bay-01", width: 3000, depth: 3000 }] })).problems.join(), /Bay-01 is used twice/);
});

const withDept = (): Tree => {
  const t = TREE.parse(JSON.parse(JSON.stringify(ICU_BAY_SAMPLE)));
  const icu = findNode(t, "ICU")!;
  icu.inputs = { ...(icu.inputs ?? {}), layout: dept(), template: "ICU-Bay-01" };
  return t;
};

test("T4: the layout becomes room nodes copied from the template; every room plans, and no wall is built twice", () => {
  const t = withDept();
  const icu = findNode(t, "ICU")!;
  const r = applyLayout(icu, layoutDepartment(dept()), (id) => findNode(t, id), "ICU-Bay-01");
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.change.add, ["ICU.Corridor", "ICU.Bay-01", "ICU.Bay-02", "ICU.Bay-03", "ICU.Store", "ICU.Bay-04"]);
  icu.children = r.children;
  assert.deepEqual(treeProblems(t, () => true), [], "ids unique, every ${var} filled");
  const bay2 = findNode(t, "ICU.Bay-02")!;
  assert.deepEqual(bay2.children!.map((c) => c.id), ["ICU.Bay-02.Room", "ICU.Bay-02.Ceiling"], "the families are loaded once, by the template");
  // each room's walls, on their centre lines: none twice
  const walls: string[] = [];
  for (const x of resolve(t).filter((x) => x.node.make?.tool === "fmc_room" && x.node.id.startsWith("ICU."))) {
    const p = planRoom(ROOM.parse((x.args as any).room));
    // a 3 m store copied from the ICU bay can't take its bed and window: the room's own checks say so before Revit
    if (x.node.id === "ICU.Store.Room") assert.match(p.problems.join(), /window .* doesn't fit a 3000 mm wall.*Bed: its 1200 mm clearance/);
    else assert.deepEqual(p.problems, [], x.node.id);
    for (const o of p.ops) if (o.op === "wall") walls.push([o.start, o.end].map((q) => q.join(",")).sort().join("|"));
  }
  assert.equal(new Set(walls).size, walls.length, "no wall doubled");
  // the south-row bay's door faces the corridor (its north wall)
  const store = resolve(t).find((x) => x.node.id === "ICU.Store.Room")!;
  assert.equal((store.args as any).room.openings[0].wall, "north");
});

test("T4: a wider room rebuilds that room and its east neighbours' positions only; a person's edits in a room survive the layout", () => {
  const t = withDept();
  const icu = findNode(t, "ICU")!;
  icu.children = applyLayout(icu, layoutDepartment(dept()), (id) => findNode(t, id), "ICU-Bay-01").children;
  const built = recordBuilt(t, null, resolve(t).filter((x) => x.node.make).map((x) => x.node.id), new Date());
  // a person adopted a hand edit in Bay-03's room
  (findNode(t, "ICU.Bay-03.Room")!.make!.args as any).keep = ["item:Bed"];
  const wider = dept();
  wider.north[1].width = 4500;
  const r = applyLayout(icu, layoutDepartment(wider), (id) => findNode(t, id), "ICU-Bay-01");
  assert.deepEqual(r.change.update.sort(), ["ICU.Bay-02", "ICU.Bay-03", "ICU.Corridor"]);
  assert.deepEqual(r.change.same.sort(), ["ICU.Bay-01", "ICU.Bay-04", "ICU.Store"]);
  icu.children = r.children;
  assert.deepEqual((findNode(t, "ICU.Bay-03.Room")!.make!.args as any).keep, ["item:Bed"], "kept through the layout");
  const changed = planTree(t, built).filter((l) => l.state !== "unchanged" && l.tool).map((l) => l.id);
  assert.ok(!changed.includes("ICU.Bay-01.Room") && !changed.includes("ICU.Store.Room"), "unmoved rooms don't rebuild");
  assert.ok(changed.includes("ICU.Bay-02.Room") && changed.includes("ICU.Bay-03.Room"));
  const gone = applyLayout(icu, layoutDepartment(dept({ south: [] })), (id) => findNode(t, id), "ICU-Bay-01");
  assert.deepEqual(gone.change.remove.sort(), ["ICU.Bay-04", "ICU.Store"]);
});
