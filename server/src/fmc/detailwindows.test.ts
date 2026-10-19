import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPONENTS } from "./detailgen.js";
import { clearanceOps, detailWindow, substituteMaterials } from "./detailwindows.js";
import { detailProduct, swungOpen } from "./detailproducts.js";
import { OP, opsProblems } from "./ops.js";
import { LOD_RENDER, NestedLod, RECIPE, lodLadder, lodLine } from "./recipes.js";

const realProblems = (ops: any[]) => opsProblems(ops.map((o) => OP.parse(o)), null).filter((x) => !/isn't readable|isn't made earlier/.test(x));
const plane = (name: string, a: number, kind: "x" | "y" | "z") => kind === "x" ? { op: "add_ref_plane", name, from: [a, -1500], to: [a, 1500] }
  : kind === "y" ? { op: "add_ref_plane", name, from: [-2500, a], to: [2500, a] } : { op: "add_ref_plane", name, from: [-2500, a], to: [2500, a], view: "Exterior" };

function window(extra: any[]) {
  return { family: "FMC_A_Window_Test", template: "Metric Window.rft", ops: [
    { op: "set_category", name: "OST_Windows" },
    { op: "add_family_param", name: "Show Blind", type: "YesNo", group: "Constraints" },
    { op: "add_family_param", name: "Show Shelf", type: "YesNo", group: "Constraints" },
    { op: "add_family_param", name: "Glass Material", type: "Material", group: "Materials" },
    { op: "add_family_param", name: "Frame Material", type: "Material", group: "Materials" },
    { op: "add_material", name: "FMC_Fabric_Blind_Venetian_White", param: "Blind Material" },
    plane("Frame Ext", -50, "y"), plane("Frame Int", 50, "y"), plane("Glass Ext", -3, "y"), plane("Glass Int", 3, "y"),
    plane("Frame L In", -400, "x"), plane("Frame R In", 400, "x"), plane("Arch L", -520, "x"), plane("Arch R", 520, "x"),
    plane("Sill Inner", 850, "z"), plane("Head Inner", 1350, "z"), plane("Arch Top", 1470, "z"),
    ...extra,
    { op: "add_type", name: "900x600" },
    { op: "set_type_value", name: "900x600/Show Shelf", type: "900x600", param: "Show Shelf", value: true },
  ] };
}

test("QS03: a missing kit material is swapped for a kit one, and the recipe says so", () => {
  const s = substituteMaterials([{ op: "add_material", name: "FMC_Fabric_Blind_Venetian_White", param: "Blind Material" }]);
  assert.equal(s.ops[0].name, "FMC_Plastic_ABS_White");
  assert.equal(s.values["Blind Material"].source_status, "assumed");
  assert.match(s.notes[0], /until the kit has it/);
});

test("QS03: a window gets the working-zone clearance with its switch; a family that has one keeps it", () => {
  const w = window([]);
  const c = clearanceOps(w, { face: "Frame Int", side: 1, from: "Left", to: "Right", depth: 500, param: "Clearance Working Zone", why: "x" });
  assert.deepEqual(c.ops.find((o) => o.op === "extrusion")!.rect, ["Left", "Right", "Frame Int", "Clear Int"]);
  assert.equal(c.ops.find((o) => o.op === "add_ref_plane")!.from[1], 550, "500 mm in front of the interior face");
  assert.ok(c.ops.some((o) => o.op === "set_visible_param" && o.param === "Show Clearance"));
  assert.equal(c.value["Clearance Working Zone"].source_status, "assumed", "rule 5: an engineer confirms it");
  const has = { ...w, ops: [...w.ops, { op: "add_family_param", name: "Show Clearance", type: "YesNo", group: "Constraints", instance: true }] };
  assert.deepEqual(clearanceOps(has, { face: "Frame Int", side: 1, from: "Left", to: "Right", depth: 500, param: "P", why: "x" }).ops, []);
});

test("QS03: a dispensing hatch splits into a fixed light and a sliding panel; Open slides it up; grille and shutter box", () => {
  const w = window([
    { op: "extrusion", name: "Glass", rect: ["Frame L In", "Frame R In", "Glass Ext", "Glass Int"], start: 850, end: 1350, end_plane: "Head Inner" },
    { op: "set_subcategory", name: "Glass", subcategory: "Glass" },
    { op: "set_material_param", name: "Glass", param: "Glass Material" },
    { op: "extrusion", name: "Shelf", rect: ["Left", "Right", "Frame Ext", "Frame Int"], start: 800, end: 820 },
  ]);
  const d = detailWindow(w, (f) => `A\\${f}.rfa`);
  const ops = d.recipe.ops;
  assert.ok(!ops.some((o) => o.op === "extrusion" && o.name === "Glass"), "the whole light is replaced");
  assert.deepEqual(ops.filter((o) => o.op === "extrusion" && /Hatch Panel|Glass Fixed/.test(o.name)).map((o) => [o.name, o.start_plane, o.end_plane]),
    [["Glass Fixed", "Hatch Top", "Head Inner"], ["Hatch Panel", "Sill Inner", "Hatch Top"], ["Hatch Panel Open", "Hatch Top", "Hatch Open Top"]]);
  assert.equal(ops.find((o) => o.op === "set_visible_param" && o.solid === "Hatch Panel Open")!.param, "Open");
  assert.equal(ops.find((o) => o.op === "add_dimension" && o.name === "Hatch Open Height")!.label, "Hatch Height", "the open panel is as tall as the closed one");
  assert.ok(ops.some((o) => o.op === "place_nested" && o.family === COMPONENTS.speech_grille.family("A")));
  assert.equal(ops.find((o) => o.op === "add_material")!.name, "FMC_Plastic_ABS_White", "the missing blind material swapped");
  assert.equal(RECIPE.safeParse(d.recipe).success, true);
  const keys = ops.map((o) => `${o.op}|${o.name}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(realProblems(ops), []);
});

/** The ladder of a generated component with its Rhino twins on Fine (what fmc_rhino twins adds). */
const twinned: NestedLod = (family) => {
  const r = Object.values(COMPONENTS).map((c) => c.recipe("A")).find((x) => x.family === family);
  return r ? lodLadder(r.family, [...r.ops, { op: "import_part", name: "Twin" }, { op: "set_visibility", name: "Twin", coarse: false, medium: false, fine: true }]) : null;
};

test("F-071: every generated window is Coarse LOD 100 (its envelope box), Medium LOD 300, Fine LOD 400 + Render with the parts' twins", () => {
  const body = [
    plane("Sill Out", -90, "y"), plane("Board In", 230, "y"), plane("Board L", -510, "x"), plane("Board R", 510, "x"), plane("Board Bot", 775, "z"),
    plane("Arch Out", 70, "y"), plane("Spacer L", -390, "x"), plane("Spacer R", 390, "x"), plane("Pane Ext In", -1, "y"), plane("Pane Int In", 1, "y"),
    plane("Spacer Top", 1338, "z"), plane("Blind Front", -0.5, "y"), plane("Blind Back", 0.5, "y"),
    plane("Knob L", 300, "x"), plane("Knob R", 330, "x"), plane("Knob Bot", 1100, "z"),
    { op: "extrusion", name: "Jamb L", rect: ["Left", "Frame L In", "Frame Ext", "Frame Int"], start: 800, end: 1400, end_plane: "Head" },
    { op: "extrusion", name: "Sill Rail", rect: ["Left", "Right", "Sill Out", "Frame Int"], start: 800, end: 850, end_plane: "Sill Inner" },
    { op: "extrusion", name: "Window Board", rect: ["Board L", "Board R", "Frame Int", "Board In"], start: 775, end: 800, end_plane: "Sill" },
    { op: "extrusion", name: "Architrave Head", rect: ["Arch L", "Arch R", "Frame Int", "Arch Out"], start: 1400, end: 1470, end_plane: "Arch Top" },
    { op: "set_visibility", name: "Architrave Head", coarse: false, medium: true, fine: true },
    { op: "extrusion", name: "Spacer L", rect: ["Frame L In", "Spacer L", "Pane Ext In", "Pane Int In"], start: 850, end: 1350, end_plane: "Head Inner" },
    { op: "set_visibility", name: "Spacer L", coarse: false, medium: false, fine: true },
  ];
  const blind = window([...body,
    { op: "add_family_param", name: "Blind Material", type: "Material", group: "Materials" },
    { op: "extrusion", name: "Integral Blind", rect: ["Spacer L", "Spacer R", "Blind Front", "Blind Back"], start: 900, end: 1338, end_plane: "Spacer Top" },
    { op: "set_visible_param", name: "Integral Blind/Visible", solid: "Integral Blind", param: "Show Blind" },
    { op: "extrusion", name: "Blind Control Knob", rect: ["Knob L", "Knob R", "Frame Int", "Board In"], start: 1100, end: 1130 },
  ]);
  const hatch = window([...body,
    { op: "extrusion", name: "Glass", rect: ["Frame L In", "Frame R In", "Glass Ext", "Glass Int"], start: 850, end: 1350, end_plane: "Head Inner" },
    { op: "set_subcategory", name: "Glass", subcategory: "Glass" },
    { op: "set_material_param", name: "Glass", param: "Glass Material" },
    plane("Shelf Out", -350, "y"), plane("Shelf In", 350, "y"),
    { op: "extrusion", name: "Shelf", rect: ["Left", "Right", "Shelf Out", "Shelf In"], start: 800, end: 820 },
  ]);
  const lab = { ...hatch, family: "FMC_A_Window_Laboratory_Fixed", ops: hatch.ops.filter((o: any) => o.name !== "Shelf") };
  for (const [w, rect, top, topPlane] of [[blind, ["Arch L", "Arch R", "Sill Out", "Board In"], 1470, "Arch Top"],
    [hatch, ["Arch L", "Arch R", "Shelf Out", "Shelf In"], 1630, "Shutter Box Top"], [lab, ["Arch L", "Arch R", "Sill Out", "Board In"], 1470, "Arch Top"]] as const) {
    const d = detailWindow(w as any, (f) => `A\\${f}.rfa`);
    const ops = d.recipe.ops;
    const env = ops.find((o) => o.op === "extrusion" && o.name === "Coarse Envelope")!;
    assert.deepEqual(env.rect, rect, `${w.family}: flexes with Width and the frame depth`);
    assert.deepEqual([env.start, env.start_plane, env.end, env.end_plane], [775, "Board Bot", top, topPlane], `${w.family}: and with Height`);
    const vis = (n: string) => ops.filter((o) => o.op === "set_visibility" && o.name === n).map((o) => [o.coarse, o.medium, o.fine]);
    assert.deepEqual(vis("Coarse Envelope"), [[true, false, false]]);
    for (const n of ["Jamb L", "Sill Rail", "Window Board", "Architrave Head"]) assert.deepEqual(vis(n), [[false, true, true]], `${w.family}: ${n}`);
    assert.deepEqual(vis("Spacer L"), [[false, false, true]], "Fine-only stays Fine-only");
    assert.deepEqual(vis("Clearance Zone"), [[true, true, false]], "the clearance keeps its levels");
    for (const o of ops.filter((x) => x.op === "extrusion" && !/Envelope|Clearance/.test(x.name)))
      assert.deepEqual(vis(o.name).map((v) => v[0]), [false], `${w.family}: ${o.name} hidden on Coarse`);
    assert.deepEqual(lodLadder(d.recipe.family, ops, twinned), { coarse: "LOD 100", medium: "LOD 300", fine: LOD_RENDER }, w.family);
    assert.equal(lodLine(d.recipe.family, ops, twinned).state, "Pass", w.family);
    assert.equal(RECIPE.safeParse(d.recipe).success, true);
    const keys = ops.map((o) => `${o.op}|${o.name}`);
    assert.equal(new Set(keys).size, keys.length, w.family);
    assert.deepEqual(realProblems(ops), [], w.family);
  }
});

test("QS03: a front-face door swings 90° outward about its hinge edge, with what it carries", () => {
  const ops = [
    { op: "extrusion", name: "Side Door 1", sketch: "front", start: 900, end: 905, points: [[-2600, 600], [-1700, 600], [-1700, 2150], [-2600, 2150]] },
    { op: "set_subcategory", name: "Side Door 1", subcategory: "Pcoat" },
    { op: "extrusion", name: "Door Handle 1", sketch: "front", start: 905, end: 925, points: [[-1810, 1250], [-1790, 1250], [-1790, 1400], [-1810, 1400]] },
  ];
  const open = swungOpen(ops, { door: "Side Door 1", carried: ["Door Handle 1"], hinge: "left" });
  const door = open.find((o) => o.name === "Side Door 1 Open")!;
  assert.deepEqual(door.points, [[-2605, -1800], [-2600, -1800], [-2600, -900], [-2605, -900]], "900 mm out from the face at y = -900, 5 mm thick beside the hinge");
  assert.deepEqual([door.start, door.end], [600, 2150]);
  const handle = open.find((o) => o.name === "Door Handle 1 Open")!;
  assert.deepEqual(handle.points, [[-2625, -1710], [-2605, -1710], [-2605, -1690], [-2625, -1690]], "the handle rides on the door's outer face");
  assert.ok(open.some((o) => o.op === "set_subcategory" && o.name === "Side Door 1 Open" && o.subcategory === "Pcoat"));
});

test("QS03: a product gets Open for its doors and the Show Clearance switch on its zone", () => {
  const std = { family: "FMC_E_EQ_Generator_Test", template: "Metric Generic Model.rft", ops: [
    { op: "extrusion", name: "Side Door 1", sketch: "front", start: 900, end: 905, points: [[-2600, 600], [-1700, 600], [-1700, 2150], [-2600, 2150]] },
    { op: "extrusion", name: "Clearance Maintenance Zone", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 2000 },
    { op: "add_type", name: "250kVA" },
    { op: "set_type_value", name: "250kVA/Width", type: "250kVA", param: "Width", value: 3000 },
  ] };
  const d = detailProduct(std, { doors: [{ door: "Side Door 1", hinge: "left" }] });
  const ops = d.recipe.ops;
  assert.equal(ops.find((o) => o.op === "set_visible_param" && o.solid === "Side Door 1")!.param, "Closed");
  assert.equal(ops.find((o) => o.op === "set_visible_param" && o.solid === "Side Door 1 Open")!.param, "Open");
  assert.equal(ops.find((o) => o.op === "set_visible_param" && o.solid === "Clearance Maintenance Zone")!.param, "Show Clearance");
  assert.ok(ops.some((o) => o.op === "set_type_value" && o.param === "Show Clearance" && o.value === true), "shown by default");
});
