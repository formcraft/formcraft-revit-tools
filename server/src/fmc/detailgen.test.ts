import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPONENTS, detailDoor, roundedRect } from "./detailgen.js";
import { OP, opsProblems } from "./ops.js";
import { RECIPE } from "./recipes.js";

const realProblems = (ops: any[]) => opsProblems(ops.map((o) => OP.parse(o)), null).filter((x) => !/isn't readable/.test(x));

test("QS03: every component is a valid recipe with the references it locks by", () => {
  for (const [kind, c] of Object.entries(COMPONENTS)) {
    const r = c.recipe("A");
    assert.equal(RECIPE.safeParse(r).success, true, kind);
    assert.equal(r.family, c.family("A"));
    assert.match(r.family, /^FMC_A_Part_[A-Za-z]+$/, "kit naming, the host's role");
    assert.deepEqual(realProblems(r.ops), [], kind);
    const refs = r.ops.filter((o) => o.op === "add_ref_plane").map((o) => o.is_reference);
    assert.ok(refs.includes("Back"), `${kind}: a Face plane marked Back`);
    assert.ok(r.ops.filter((o) => o.op === "set_visibility").every((o) => o.coarse === false && o.medium && o.fine), `${kind}: hidden on Coarse (LOD 100 is the host's box)`);
    assert.ok(r.checks?.keynote_exempt, `${kind}: nested, never scheduled on its own`);
  }
  assert.equal(roundedRect(40, 20, 5).length, 16);
});

/** A small door in the dgen2 plane scheme: just what the generator reads. */
function door() {
  const plane = (name: string, x?: number, y?: number, z?: number) => z !== undefined
    ? { op: "add_ref_plane", name, from: [-2500, z], to: [2500, z], view: "Exterior" }
    : x !== undefined ? { op: "add_ref_plane", name, from: [x, -1500], to: [x, 1500] } : { op: "add_ref_plane", name, from: [-2500, y], to: [2500, y] };
  const ops: any[] = [
    { op: "set_category", name: "OST_Doors" },
    { op: "add_family_param", name: "Leaf Thickness", type: "Length", group: "Dimensions" },
    { op: "add_family_param", name: "Main Leaf Width", type: "Length", group: "Dimensions" },
    { op: "add_family_param", name: "Leaf B Width", type: "Length", group: "Dimensions" },
    { op: "add_family_param", name: "Leaf Material", type: "Material", group: "Materials" },
    { op: "add_family_param", name: "Pair", type: "YesNo", group: "Constraints" },
    { op: "add_family_param", name: "Show Closer", type: "YesNo", group: "Constraints" },
    { op: "add_family_param", name: "Show Vision Panel", type: "YesNo", group: "Constraints" },
    plane("Leaf Left", -423), plane("Leaf Right", 423), plane("Rose L", 337), plane("Rose R", 389), plane("Closer L", -374),
    plane("Leaf Ext", undefined, -22.5), plane("Leaf Int", undefined, 22.5),
    plane("Lever Mid", undefined, undefined, 1000), plane("Closer Bot", undefined, undefined, 1960), plane("Leaf Top", undefined, undefined, 2057),
    plane("Hinge 1 Bot", undefined, undefined, 250), plane("Hinge 2 Bot", undefined, undefined, 1000), plane("Hinge 3 Bot", undefined, undefined, 1707),
    { op: "extrusion", name: "Leaf A", rect: ["Leaf Left", "Leaf Right", "Leaf Ext", "Leaf Int"], start: 8, end: 2057, end_plane: "Leaf Top" },
    { op: "set_subcategory", name: "Leaf A", subcategory: "Leaf" },
    { op: "set_material_param", name: "Leaf A", param: "Leaf Material" },
    { op: "set_visible_param", name: "Leaf A/Visible", solid: "Leaf A", param: "Show Vision Panel" },
    { op: "extrusion", name: "Lever Rose Ext", rect: ["Rose L", "Rose R", "Leaf Ext", "Leaf Int"], start: 974, end: 1026 },
    { op: "set_subcategory", name: "Lever Rose Ext", subcategory: "Hardware" },
    { op: "extrusion", name: "Hinge A 1", rect: ["Leaf Left", "Rose L", "Leaf Ext", "Leaf Int"], start: 250, end: 350 },
    { op: "extrusion", name: "Closer Body", rect: ["Closer L", "Rose L", "Leaf Ext", "Leaf Int"], start: 1960, end: 2020 },
    { op: "set_visible_param", name: "Closer Body/Visible", solid: "Closer Body", param: "Show Closer" },
    { op: "add_type", name: "0926x2100_S" },
    { op: "set_type_value", name: "0926x2100_S/Pair", type: "0926x2100_S", param: "Pair", value: false },
  ];
  return { family: "FMC_A_Door_FlushSingle_Test", template: "Metric Door.rft", ops };
}

test("QS03: a door's box hardware becomes components locked on its planes, and the door can open", () => {
  const d = detailDoor(door(), (f) => `A\\${f}.rfa`);
  const ops = d.recipe.ops;
  assert.equal(d.recipe.family, "FMC_A_Door_FlushSingle_Test_Detailed");
  assert.deepEqual(d.components, ["FMC_A_Part_LeverRose", "FMC_A_Part_ButtHinge", "FMC_A_Part_OverheadCloser"]);
  // the boxes are gone, with everything about them; the planes they used stay
  for (const n of ["Lever Rose Ext", "Hinge A 1", "Closer Body"])
    assert.ok(!ops.some((o) => (o.op === "extrusion" && o.name === n) || (o.op !== "set_visible_param" && o.solid === n) || (o.op === "set_subcategory" && o.name === n)), n);
  assert.equal(ops.find((o) => o.name === "Hinge A 1")!.op, "place_nested", "the hinge keeps its name as a component");
  assert.ok(ops.some((o) => o.op === "add_ref_plane" && o.name === "Rose L"));
  // the components ride the planes: exterior lever on the exterior face, interior one turned round on the interior face
  const nested = (n: string) => ops.find((o) => o.op === "place_nested" && o.name === n)!;
  assert.deepEqual(nested("Lever Ext").lock, { x: { plane: "Rose L", ref: "Left", at: -26 }, y: { plane: "Leaf Ext", ref: "Back" }, z: { plane: "Lever Mid", ref: "CenterElevation" } });
  assert.equal(nested("Lever Int").rotate_deg, 180);
  assert.equal(nested("Lever Int").type, "52_ArmRight", "turned round and mirrored: it still points to the hinge");
  assert.equal(nested("Hinge A 3").lock.z.plane, "Hinge 3 Bot");
  assert.ok(ops.some((o) => o.op === "set_visible_param" && o.solid === "Hinge B 2" && o.param === "Pair"), "the pair leaf's hinges only with Pair");
  // Open: an instance switch; the closed leaf keeps its own switch and adds not(Open); the open leaf is on new planes
  assert.deepEqual(ops.find((o) => o.op === "add_family_param" && o.name === "Open"), { op: "add_family_param", name: "Open", type: "YesNo", group: "Constraints", instance: true });
  assert.equal(ops.find((o) => o.op === "set_visible_param" && o.solid === "Leaf A")!.param, "Show Vision Panel Closed");
  assert.equal(ops.find((o) => o.op === "set_formula" && o.name === "Show Vision Panel Closed")!.formula, "and(Show Vision Panel, not(Open))");
  assert.equal(ops.find((o) => o.op === "set_visible_param" && o.solid === "Closer")!.param, "Show Closer Closed", "the closer keeps its own switch too");
  assert.deepEqual(ops.find((o) => o.op === "extrusion" && o.name === "Leaf A Open")!.rect, ["Leaf Left", "Open Leaf Face", "Leaf Int", "Open Leaf Tip"]);
  assert.equal(ops.find((o) => o.op === "add_dimension" && o.name === "Open Leaf Width")!.label, "Main Leaf Width", "the open leaf flexes with the width");
  assert.equal(ops.find((o) => o.op === "set_material_param" && o.name === "Leaf A Open")!.param, "Leaf Material");
  // each op only once, and nothing the recipe check calls wrong
  const keys = ops.map((o) => `${o.op}|${o.name}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(realProblems(ops).filter((x) => !/isn't made earlier/.test(x)), []);
});

test("QS03: a recipe that isn't a dgen2 door is refused, not half-detailed", () => {
  assert.throws(() => detailDoor({ family: "FMC_A_Door_X", template: "Metric Door.rft", ops: [{ op: "set_category", name: "OST_Doors" }] }, (f) => f), /isn't a dgen2 door: no plane Leaf Left/);
});

test("QS03 fix: the lever rose has a type before its formula (the Generic Model template starts with none)", () => {
  const ops = COMPONENTS.lever_rose.recipe("A").ops as Array<{ op: string; name?: string }>;
  const firstType = ops.findIndex((o) => o.op === "add_type"), formula = ops.findIndex((o) => o.op === "set_formula");
  assert.ok(firstType >= 0 && firstType < formula);
  assert.equal(ops.filter((o) => o.op === "add_type" && o.name === "52_ArmLeft").length, 1);
});

test("QS03 fix: an extrusion locked to the same plane at both ends is refused before Revit", () => {
  const p = opsProblems([
    { op: "add_ref_plane", name: "Top", from: [-100, 50], to: [100, 50] },
    { op: "extrusion", name: "Slab", rect: ["Center (Left/Right)", "Center (Left/Right)", "Center (Front/Back)", "Center (Front/Back)"], start: 40, end: 50, start_plane: "Top", end_plane: "Top" },
  ] as any, null);
  assert.ok(p.some((x) => /both locked to "Top"/.test(x)));
});
