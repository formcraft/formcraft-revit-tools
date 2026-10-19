import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCis } from "../fmc/brief.js";
import { treeFromBrief, treeQuantities } from "./building.js";
import { planTree, resolve, treeProblems } from "./tree.js";
import { ROOM, planRoom } from "./room.js";

const CIS = parseCis(JSON.stringify({
  schema: "fmc-cis/0.1", project: "F26001", revision: "R4", approved: "2026-10-13",
  levels: [{ name: "00 Ground Floor", elevation_mm: 0 }, { name: "01 First Floor", elevation_mm: 4200 }, { name: "02 Roof", elevation_mm: 7500 }],
  project_info: {},
  rooms: [
    { number: "G01", name: "Reception", params: { FMC_Target_Area: 18, FMC_Department: "Outpatients", FMC_Finish_Set: "FS-01" } },
    { number: "G02", name: "Consult 1", params: { FMC_Target_Area: 12, FMC_Department: "Outpatients" } },
    { number: "G03", name: "Consult 2", params: { FMC_Target_Area: 12, FMC_Department: "Outpatients" } },
    { number: "G04", name: "Clean store", params: { FMC_Target_Area: 6, FMC_Department: "Support" } },
    { number: "101", name: "ICU bay 1", params: { FMC_Department: "ICU" } },
    { number: "102", name: "ICU bay 2", params: { FMC_Department: "ICU" } },
    { number: "103", name: "Nurse station", level: "01 First Floor", params: { FMC_Target_Area: 9, FMC_Department: "ICU" } },
  ],
  materials: [], families: [],
})).cis!;

const OPTIONS = { wall_type: "Generic - 200mm", wall_thickness: 200, ceiling_type: "Generic", ceiling_height: 2900, corridor_width: 2400,
  level_prefixes: { G: "00 Ground Floor", "1": "01 First Floor" }, templates: [{ match: "ICU bay", template: "Library.ICU-Bay" }] };

test("T5: the brief becomes one tree: levels, departments along corridors, rooms from library templates", () => {
  const b = treeFromBrief(CIS, OPTIONS);
  assert.deepEqual(b.problems, []);
  assert.deepEqual(treeProblems(b.tree, () => true), [], "every ${var} filled, ids unique");
  const levels = b.tree.root.children!.filter((c) => c.kind === "level");
  assert.deepEqual(levels.map((l) => [l.name, l.inputs!.structure_height]), [["00 Ground Floor", 4200], ["01 First Floor", 3300]], "the roof has no rooms; each structure height is the step to the next level");
  assert.deepEqual(levels[0].children!.map((d) => d.name), ["Outpatients", "Support"]);
  const g02 = b.sizes.find((s) => s.number === "G02")!;
  assert.deepEqual(g02.size, [4000, 3000], "12 m² over the plain template's 3000 depth");
  assert.match(g02.from, /12 m² over the template's 3000 mm depth/);
  const store = b.sizes.find((s) => s.number === "G04")!;
  assert.deepEqual(store.size, [2000, 3000]);
  const bay = b.sizes.find((s) => s.number === "101")!;
  assert.equal(bay.template, "Library.ICU-Bay");
  assert.deepEqual(bay.size, [4200, 5000], "no target area: the template's own size");
});

test("T5: the library is never built; families first; each room carries its programme data to Revit", () => {
  const b = treeFromBrief(CIS, OPTIONS);
  const tools = planTree(b.tree, null).filter((l) => l.tool).map((l) => l.id);
  assert.ok(!tools.some((id) => id.startsWith("Library")), "templates aren't built");
  assert.ok(tools[0].startsWith("Families."), "the families load before any room");
  const g01 = resolve(b.tree).find((r) => r.node.id.endsWith(".G01.Room"))!;
  const room = ROOM.parse((g01.args as any).room);
  assert.equal(room.number, "G01");
  assert.equal(room.name, "Reception");
  const op = planRoom(room).ops.find((o) => o.op === "room") as any;
  assert.deepEqual(op.params, { FMC_Target_Area: 18, FMC_Department: "Outpatients", FMC_Finish_Set: "FS-01" });
});

test("T5: quantities across the building; no wall twice on a level; rooms off their target are named", () => {
  const b = treeFromBrief(CIS, OPTIONS);
  const q = treeQuantities(b.tree);
  assert.equal(q.total.rooms, 7 + 3, "seven rooms and three corridors");
  assert.deepEqual(q.problems, [], "every room passes its own checks");
  assert.deepEqual(Object.keys(q.by_level), ["00 Ground Floor", "01 First Floor"]);
  assert.equal(q.by_department["00 Ground Floor › Outpatients"].target_m2, 42);
  assert.deepEqual(q.off_target, [], "sizes derived from the targets meet them");
  // a person widens a consult room by hand in the tree: the check names it
  const g03 = b.tree.root.children!.find((c) => c.kind === "level")!.children![0].children!.find((c) => c.id.endsWith(".G03"))!;
  g03.inputs = { ...g03.inputs, width: 5000 };
  assert.match(treeQuantities(b.tree).off_target.join(), /G03 Consult 2: 15 m² planned, 12 m² in the brief \(\+25%\)/);
  const walls = new Map<string, string[]>();
  for (const r of resolve(b.tree).filter((x) => x.node.make?.tool === "fmc_room" && !x.path.includes("Library"))) {
    const room = ROOM.parse((r.args as any).room);
    for (const o of planRoom(room).ops) if (o.op === "wall") {
      const k = `${room.level}|${[o.start, o.end].map((p) => p.join(",")).sort().join("|")}`;
      walls.set(k, [...(walls.get(k) ?? []), r.node.id]);
    }
  }
  const doubled = [...walls.entries()].filter(([, v]) => v.length > 1);
  assert.deepEqual(doubled, [], "no wall doubled");
});

test("T5: a room with no level, or rooms on the top level without a height, are problems, never guessed", () => {
  const noPrefix = treeFromBrief(CIS, { ...OPTIONS, level_prefixes: { G: "00 Ground Floor" } });
  assert.match(noPrefix.problems.join(), /101 ICU bay 1: no level/);
  const top = parseCis(JSON.stringify({ schema: "fmc-cis/0.1", project: "P", levels: [{ name: "L0", elevation_mm: 0 }],
    rooms: [{ number: "1", name: "Room", level: "L0", params: {} }] })).cis!;
  assert.match(treeFromBrief(top, OPTIONS).problems.join(), /no level above it: give top_structure_height/);
  assert.deepEqual(treeFromBrief(top, { ...OPTIONS, top_structure_height: 3000 }).problems, []);
});
