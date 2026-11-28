import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSharedParameters } from "./specs.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { opsProblems, splitProblems } from "./ops.js";
import { RECIPE } from "./recipes.js";
import { LEGEND_VIEW, directionFor, placePlan } from "./legendmath.js";
import { SINKO_COUNT, SINKO_PARAMS } from "./sinkoparams.js";
import {
  LEGEND_BACK, LEGEND_FRONT, TEMPLATE_PLANES, coerceValue, familyName, legendLines, planGenerateBind, planId, resolveSinko, type GbInput,
} from "./generatebind.js";
import { runFmcGenerateBind, type FmcGenerateBindArgs } from "../tools/fmc_generate_bind.js";

// The eleven as they are in the kit (FMC_Kit_v2.2 FMC_SharedParameters.txt, 19 Oct 2026): name, GUID, data type, group.
const KIT_ROWS: Array<[string, string, string, number]> = [
  ["FMC_Frame_Spec", "7a163363-b62c-57f9-8d75-66d6b9aad4c6", "TEXT", 25],
  ["FMC_Glazing_Spec", "0dbd1462-d156-50f3-9038-a0ed6baa5880", "TEXT", 25],
  ["FMC_Ironmongery_Set", "1f71895f-a957-5735-b684-00aa31d91721", "TEXT", 25],
  ["FMC_Finish_Primary", "75a7af00-35cb-5c87-94cd-5571ba88ee94", "TEXT", 6],
  ["FMC_Fire_Resistance_Min", "2f80614a-7f11-5b2a-91a6-a8431863183e", "INTEGER", 6],
  ["FMC_Acoustic_Rating_Rw", "171b8d36-974e-58af-bc1f-5285962d6598", "INTEGER", 6],
  ["FMC_Vent_Type", "cfd77ccf-d77d-53e0-b769-10b62e8aa1d5", "TEXT", 6],
  ["FMC_Fanlight_Height_mm", "425ed7f1-679a-5ee8-98dc-4fad02fde0ed", "INTEGER", 6],
  ["FMC_Mosquito_Mesh", "5ec6628e-e5ce-55d7-a8c1-d1737876b897", "YESNO", 6],
  ["FMC_Glazed_Area_m2", "c3c61f30-7abb-515e-9902-4cf9a3b72200", "AREA", 6],
  ["FMC_Openable_Area_m2", "6919d4a2-ffd3-5f03-bbd5-4715a375a99d", "AREA", 6],
];
const KIT_TEXT = [
  "# This is a Revit shared parameter file.",
  "*META\tVERSION\tMINVERSION", "META\t2\t1",
  "*GROUP\tID\tNAME", "GROUP\t6\tFMC_06_Architecture_Interiors", "GROUP\t25\tFMC_25_Doors_Windows",
  "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEWHENNOVALUE",
  ...KIT_ROWS.map(([n, g, t, grp]) => `PARAM\t${g}\t${n}\t${t}\t\t${grp}\t1\t\t1\t0`),
  "",
].join("\n");
const KIT = parseSharedParameters(KIT_TEXT);

const door = (over: Partial<GbInput> = {}): GbInput => ({
  kind: "door", operation: "hinged_left",
  types: [{ width_mm: 900, height_mm: 2100 }, { width_mm: 800, height_mm: 2100, type_mark: "D07" }],
  values: { FMC_Frame_Spec: "Hardwood frame, clear lacquer", FMC_Fire_Resistance_Min: 30, FMC_Mosquito_Mesh: "no" },
  ...over,
});
const windowIn = (operation: GbInput["operation"], over: Partial<GbInput> = {}): GbInput =>
  ({ kind: "window", operation, types: [{ width_mm: 1200, height_mm: 1200 }], ...over });

const opsOf = (recipe: Record<string, any>, op: string) => (recipe.ops as Array<Record<string, any>>).filter((o) => o.op === op);

function recipeErrors(plan: ReturnType<typeof planGenerateBind>) {
  const parsed = RECIPE.safeParse(plan.recipe);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
  return splitProblems(opsProblems(parsed.data!.ops, KIT, undefined, undefined, { templatePlanes: TEMPLATE_PLANES[plan.kind], template: plan.template })).errors;
}

test("the Sinko config lists eleven distinct kit parameters, all type parameters", () => {
  assert.equal(SINKO_COUNT, 11);
  assert.equal(SINKO_PARAMS.length, 11);
  assert.equal(new Set(SINKO_PARAMS.map((p) => p.name)).size, 11);
  assert.equal(new Set(SINKO_PARAMS.map((p) => p.column)).size, 11);
  for (const p of SINKO_PARAMS) {
    assert.match(p.name, /^FMC_/);
    assert.equal(p.instance, false, `${p.name} must be a type parameter: a legend component shows a type`);
  }
  assert.deepEqual(SINKO_PARAMS.map((p) => p.name).sort(), KIT_ROWS.map((r) => r[0]).sort());
});

test("GUIDs and data types come from the kit file; a missing name or file is refused, never invented", () => {
  const ok = resolveSinko(KIT);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.params.length, 11);
  for (const [n, g, t] of KIT_ROWS) {
    const p = ok.params.find((x) => x.name === n)!;
    assert.equal(p.guid, g);
    assert.equal(p.datatype, t);
  }
  const short = parseSharedParameters(KIT_TEXT.split("\n").filter((l) => !l.includes("FMC_Acoustic_Rating_Rw")).join("\n"));
  const missing = resolveSinko(short);
  assert.equal(missing.params.length, 10);
  assert.match(missing.problems.join(" "), /FMC-PARAM-NOT-IN-KIT.*FMC_Acoustic_Rating_Rw/);
  assert.match(resolveSinko(null, "Z:\\kit.txt").problems.join(" "), /FMC-PARAM-FILE.*Z:\\kit\.txt/);
  const plan = planGenerateBind(door(), short);
  assert.match(plan.problems.join(" "), /FMC-PARAM-NOT-IN-KIT/);
});

test("a door: one recipe the recipe checker accepts, eleven shared parameters bound by kit GUID as type parameters", () => {
  const plan = planGenerateBind(door(), KIT);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.family, "FMC_A_Door_Legend_hinged_left");
  assert.equal(plan.template, "Metric Door.rft");
  assert.deepEqual(recipeErrors(plan), []);
  const shared = opsOf(plan.recipe, "add_shared_param");
  assert.equal(shared.length, 11);
  for (const [n, g] of KIT_ROWS) {
    const op = shared.find((o) => o.name === n)!;
    assert.equal(op.guid, g);
    assert.equal(op.instance, false);
  }
  assert.equal(opsOf(plan.recipe, "set_category")[0].name, "OST_Doors");
  // F-026: the default size is set before any plane is drawn
  const ops = plan.recipe.ops as Array<Record<string, any>>;
  assert.ok(ops.findIndex((o) => o.op === "set_default_size") < ops.findIndex((o) => o.op === "add_ref_plane"));
  // every solid is locked to planes (rect), so each type flexes
  for (const e of opsOf(plan.recipe, "extrusion")) assert.equal(e.rect.length, 4, `${e.name} is not locked to planes`);
  assert.deepEqual(opsOf(plan.recipe, "extrusion").map((e) => e.name), ["Jamb Left", "Jamb Right", "Head Rail", "Leaf"]);
  assert.deepEqual(opsOf(plan.recipe, "add_type").map((o) => o.name), ["0900x2100", "0800x2100"]);
});

test("front and back legend geometry: the same plane-locked lines on Legend Front (exterior) and Legend Back (interior, dashed)", () => {
  const plan = planGenerateBind(door({ frame_depth_mm: 120 }), KIT);
  const sets = opsOf(plan.recipe, "symbolic_lines");
  assert.equal(sets.length, 2);
  const front = sets.find((s) => s.subcategory === LEGEND_FRONT)!;
  const back = sets.find((s) => s.subcategory === LEGEND_BACK)!;
  assert.equal(front.view, "front");
  assert.equal(back.view, "front");
  assert.equal(front.at, -60);
  assert.equal(back.at, 60);
  assert.deepEqual(front.lines, back.lines);
  for (const l of front.lines) for (const end of [l.from, l.to]) assert.equal(end.planes.length, 2, "every legend line end is on two planes");
  // hinged left: both lines meet on the hinge side (Frame L In) at mid height
  assert.deepEqual(front.lines[0].to.planes, ["Frame L In", "Opening Mid H"]);
  const subs = opsOf(plan.recipe, "add_subcategory");
  assert.equal(subs.find((s) => s.name === LEGEND_BACK)!.line_pattern, "Dash");
  assert.equal(subs.find((s) => s.name === LEGEND_FRONT)!.line_pattern, undefined);
  assert.deepEqual(plan.legend_geometry.map((g) => [g.face, g.subcategory]), [["front", LEGEND_FRONT], ["back", LEGEND_BACK]]);
  const right = planGenerateBind(door({ operation: "hinged_right" }), KIT);
  assert.deepEqual(opsOf(right.recipe, "symbolic_lines")[0].lines[0].to.planes, ["Frame R In", "Opening Mid H"]);
});

test("windows: every operation builds a clean recipe; lines per operation; fixed glazing has none", () => {
  const expect: Record<string, number> = { casement_left: 2, casement_right: 2, top_hung: 2, bottom_hung: 2, sliding: 1, fixed: 0 };
  for (const [operation, n] of Object.entries(expect)) {
    const plan = planGenerateBind(windowIn(operation as GbInput["operation"]), KIT);
    assert.deepEqual(plan.problems, [], operation);
    assert.deepEqual(recipeErrors(plan), [], operation);
    assert.equal(legendLines("window", operation as any).length, n, operation);
    assert.equal(opsOf(plan.recipe, "symbolic_lines").length, n ? 2 : 0, operation);
    assert.equal(opsOf(plan.recipe, "set_category")[0].name, "OST_Windows");
    assert.ok(opsOf(plan.recipe, "extrusion").some((e) => e.name === "Sill Rail" && e.start_plane === "Sill"));
  }
  assert.match(planGenerateBind(windowIn("fixed"), KIT).notes.join(" "), /no opening lines/);
  const top = opsOf(planGenerateBind(windowIn("top_hung"), KIT).recipe, "symbolic_lines")[0];
  assert.deepEqual(top.lines[0].to.planes, ["Opening Mid V", "Head Inner"]);
});

test("area columns are formulas from the geometry; a value for them is refused", () => {
  const formula = (operation: GbInput["operation"], name: string) =>
    opsOf(planGenerateBind(windowIn(operation), KIT).recipe, "set_formula").find((o) => o.name === name)?.formula;
  assert.equal(formula("casement_left", "FMC_Glazed_Area_m2"), "(Width - 2 * Frame Width) * (Height - 2 * Frame Width)");
  assert.equal(formula("casement_left", "FMC_Openable_Area_m2"), "(Width - 2 * Frame Width) * (Height - 2 * Frame Width)");
  assert.match(formula("sliding", "FMC_Openable_Area_m2")!, /\* 0\.5$/);
  assert.match(formula("fixed", "FMC_Openable_Area_m2")!, /\* 0$/);
  const doorPlan = planGenerateBind(door(), KIT);
  assert.equal(opsOf(doorPlan.recipe, "set_formula").find((o) => o.name === "FMC_Openable_Area_m2")?.formula, "(Width - 2 * Frame Width) * (Height - Frame Width)");
  // a door's glazed area is a value (a solid leaf has none unless the call says so)
  assert.equal(opsOf(doorPlan.recipe, "set_formula").find((o) => o.name === "FMC_Glazed_Area_m2"), undefined);
  const bad = planGenerateBind(windowIn("fixed", { values: { FMC_Glazed_Area_m2: 1.2 } }), KIT);
  assert.match(bad.problems.join(" "), /FMC-GB-VALUE.*FMC_Glazed_Area_m2 is a formula/);
});

test("values are checked against the kit data type and land on every type; a type's own value wins", () => {
  assert.deepEqual(coerceValue({ name: "M", datatype: "YESNO" }, "no"), { value: false });
  assert.deepEqual(coerceValue({ name: "F", datatype: "INTEGER" }, "60"), { value: 60 });
  assert.match(coerceValue({ name: "F", datatype: "INTEGER" }, "half an hour").problem!, /FMC-GB-VALUE/);
  assert.match(coerceValue({ name: "F", datatype: "INTEGER" }, 30.5).problem!, /whole number/);
  const plan = planGenerateBind(door({
    types: [{ width_mm: 900, height_mm: 2100, values: { FMC_Fire_Resistance_Min: 60 } }, { width_mm: 800, height_mm: 2100 }],
  }), KIT);
  assert.deepEqual(plan.problems, []);
  const fire = opsOf(plan.recipe, "set_type_value").filter((o) => o.param === "FMC_Fire_Resistance_Min").map((o) => [o.type, o.value]);
  assert.deepEqual(fire, [["0900x2100", 60], ["0800x2100", 30]]);
  const mesh = opsOf(plan.recipe, "set_type_value").filter((o) => o.param === "FMC_Mosquito_Mesh").map((o) => o.value);
  assert.deepEqual(mesh, [false, false]);
  const unknown = planGenerateBind(door({ values: { FMC_Colour: "red" } }), KIT);
  assert.match(unknown.problems.join(" "), /"FMC_Colour" is not one of the eleven/);
});

test("the legend-schedule row: Type Mark, Width, Height and the eleven columns, one row per type", () => {
  const plan = planGenerateBind(door(), KIT);
  assert.equal(plan.legend_rows.length, 2);
  const [a, b] = plan.legend_rows;
  assert.equal(Object.keys(a.cells).length, 3 + 11);
  assert.equal(a.cells["Type Mark"], "D01");
  assert.equal(b.cells["Type Mark"], "D07");
  assert.equal(a.cells.Frame, "Hardwood frame, clear lacquer");
  assert.equal(a.cells["Fire (min)"], 30);
  assert.equal(a.cells.Glazing, "");
  assert.match(String(a.cells["Openable area (m2)"]), /^= \(Width/);
  assert.match(plan.notes.join(" "), /left blank.*FMC_Glazing_Spec/);
  const place = plan.legend_place as any;
  assert.deepEqual(place.views.map((v: any) => v.direction), [LEGEND_VIEW.elevation_front, LEGEND_VIEW.elevation_back]);
  assert.deepEqual(place.views.map((v: any) => v.hide_subcategory), [LEGEND_BACK, LEGEND_FRONT]);
  assert.equal(place.schedule_fields.length, 14);
});

test("names, sizes and operations are checked before anything is planned for Revit", () => {
  assert.equal(familyName({ kind: "window", description: "Alu top-hung 1200" }), "FMC_A_Window_Alu_top_hung_1200");
  assert.match(planGenerateBind(door({ family: "FMC_A_Window_Wrong" }), KIT).problems.join(" "), /Door token/);
  assert.match(planGenerateBind(door({ family: "Door 1" }), KIT).problems.join(" "), /FMC-GB-NAME/);
  assert.match(planGenerateBind(door({ family: "FMC_A_Door_HEBERT_Main" }), KIT).problems.join(" "), /FMC-GB-GUARD/);
  assert.match(planGenerateBind(door({ operation: "top_hung" }), KIT).problems.join(" "), /FMC-GB-OPERATION/);
  assert.match(planGenerateBind(door({ types: [{ width_mm: 150, height_mm: 2100 }] }), KIT).problems.join(" "), /FMC-GB-SIZE/);
  assert.match(planGenerateBind(door({ leaf_thickness_mm: 120 }), KIT).problems.join(" "), /thinner than the frame/);
  assert.match(planGenerateBind(door({ types: [{ width_mm: 900, height_mm: 2100 }, { name: "0900x2100", width_mm: 900, height_mm: 2100 }] }), KIT).problems.join(" "), /given twice/);
});

test("plan_id is stable for the same call and changes when the call changes", () => {
  const a = planId(planGenerateBind(door(), KIT).recipe);
  assert.equal(a, planId(planGenerateBind(door(), KIT).recipe));
  assert.match(a, /^gb-[0-9a-f]{16}$/);
  assert.notEqual(a, planId(planGenerateBind(door({ frame_depth_mm: 110 }), KIT).recipe));
});

test("fmc_legend place can set Elevation: Back for doors and windows (front stays the default)", () => {
  assert.equal(directionFor("door")!.value, LEGEND_VIEW.elevation_front);
  assert.equal(directionFor("window", "back")!.value, LEGEND_VIEW.elevation_back);
  assert.equal(directionFor("wall", "back")!.name, "section");
  const planned = placePlan({ types: [{ id: 1, category: "door" }, { id: 1, category: "door", view: "back" }], columns: 2, spacing_x_mm: 185, spacing_y_mm: 34, origin_x_mm: 15, origin_y_mm: 0, length_mm: 1000 });
  assert.deepEqual(planned.items.map((i) => i.direction), [-7, -6]);
});

// ---- the tool -------------------------------------------------------------------------------------------------------

const STAGING = "C:\\FMC\\00_Standards\\04_Families\\_Staging";
function guard(reports: string, over: Partial<GuardConfig> = {}): GuardConfig {
  return { ...DEFAULT_CONFIG, write_roots: [STAGING], family_staging_root: STAGING, shared_parameter_file: "C:\\FMC\\kit.txt", reports_dir: reports, ...over };
}
const args = (over: Partial<FmcGenerateBindArgs> = {}): FmcGenerateBindArgs => ({
  kind: "door", operation: "hinged_left", family: "", description: "", types: [{ width_mm: 900, height_mm: 2100 }],
  frame_depth_mm: 100, leaf_thickness_mm: 45, sill_height_mm: 800, values: {}, source_status: "assumed", source: "",
  dry_run: true, confirm: false, plan_id: "", overwrite: false, ...over,
});
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fmc-gb-"));

test("the dry run is the default and writes nothing: no build, no log row, no file", async () => {
  const reports = tmp();
  let builds = 0;
  const r = await runFmcGenerateBind(args(), { guard: guard(reports), dictionary: KIT, exists: () => false, build: async () => { builds++; return { body: {}, isError: false }; } });
  const b = body(r);
  assert.equal(r.isError, false);
  assert.equal(b.dry_run, true);
  assert.equal(b.wrote, false);
  assert.equal(b.saved, false);
  assert.equal(b.staging_path, `${STAGING}\\A\\FMC_A_Door_Legend_hinged_left.rfa`);
  assert.equal(b.shared_parameters.length, 11);
  assert.equal(b.legend_schedule_rows.length, 1);
  assert.equal(b.recipe.family, "FMC_A_Door_Legend_hinged_left");
  assert.deepEqual(b.build_blockers, []);
  assert.match(b.next, new RegExp(b.plan_id));
  assert.equal(builds, 0);
  // a refused dry run writes nothing either
  const refused = await runFmcGenerateBind(args({ family: "Bad name" }), { guard: guard(reports), dictionary: KIT, exists: () => false });
  assert.equal(refused.isError, true);
  assert.deepEqual(fs.readdirSync(reports), []);
});

test("a build needs confirm and the dry run's plan_id; then it runs the recipe build with exactly that plan", async () => {
  const reports = tmp();
  const seen: Array<Record<string, any>> = [];
  const io = { guard: guard(reports), dictionary: KIT, exists: () => false, log: () => {},
    build: async (recipe: Record<string, unknown>) => { seen.push(recipe); return { body: { built: true, gate: { verdict: "Pass" } }, isError: false }; } };
  const dry = body(await runFmcGenerateBind(args(), io));
  const noConfirm = await runFmcGenerateBind(args({ dry_run: false, plan_id: dry.plan_id }), io);
  assert.equal(body(noConfirm).code, "FMC-GB-DRY-RUN-FIRST");
  const noId = await runFmcGenerateBind(args({ dry_run: false, confirm: true }), io);
  assert.equal(body(noId).code, "FMC-GB-DRY-RUN-FIRST");
  const changed = await runFmcGenerateBind(args({ dry_run: false, confirm: true, plan_id: dry.plan_id, frame_depth_mm: 120 }), io);
  assert.match(body(changed).reasons[0], /inputs changed since the dry run/);
  assert.equal(seen.length, 0);
  const ok = await runFmcGenerateBind(args({ dry_run: false, confirm: true, plan_id: dry.plan_id }), io);
  const b = body(ok);
  assert.equal(ok.isError, false);
  assert.equal(b.dry_run, false);
  assert.equal(b.saved, true);
  assert.equal(b.build.gate.verdict, "Pass");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], dry.recipe);
});

test("staging rules hold: outside the write roots, an existing family, a missing kit file", async () => {
  const reports = tmp();
  const outside = guard(reports, { write_roots: ["C:\\Elsewhere"] });
  const dry = body(await runFmcGenerateBind(args(), { guard: outside, dictionary: KIT, exists: () => false }));
  assert.match(dry.build_blockers.join(" "), /Not inside an allowed write folder/);
  const apply = await runFmcGenerateBind(args({ dry_run: false, confirm: true, plan_id: dry.plan_id }), { guard: outside, dictionary: KIT, exists: () => false, log: () => {} });
  assert.equal(body(apply).code, "FMC-GB-PATH");
  const io = { guard: guard(reports), dictionary: KIT, exists: () => true, log: () => {}, build: async () => ({ body: {}, isError: false }) };
  const d2 = body(await runFmcGenerateBind(args(), io));
  assert.match(d2.build_blockers.join(" "), /exists/);
  assert.equal(body(await runFmcGenerateBind(args({ dry_run: false, confirm: true, plan_id: d2.plan_id }), io)).code, "FMC-GB-EXISTS");
  const noKit = await runFmcGenerateBind(args(), { guard: guard(reports), dictionary: null, exists: () => false });
  assert.equal(noKit.isError, true);
  assert.equal(body(noKit).code, "FMC-PARAM-FILE");
});

test("fmc_generate_bind registers with the other tools", async () => {
  const { registerTools } = await import("../tools/register.js");
  const names: string[] = [];
  const report = await registerTools({ tool: (name: string) => { names.push(name); } } as any);
  assert.deepEqual(report.failed, []);
  assert.ok(names.includes("fmc_generate_bind"));
});
