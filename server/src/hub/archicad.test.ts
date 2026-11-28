import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type GuardConfig } from "../fmc/policy.js";
import {
  F, buildGdl, checkXml, exportFamily, gdlName, kitMaterials, mapParamType, objectGuid, paramList, pathFromPlanes, recipeModel,
  recipePlanes, reportModel, toXml, translateFormula,
} from "./archicad.js";
import { runFmcArchicad, FMC_ARCHICAD_SHAPE } from "../tools/fmc_archicad.js";
import { z } from "zod";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIX = path.join(REPO, "tests", "archicad");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const kit = kitMaterials(read("FMC_Materials.sample.json"));
const row = <T extends { name?: string; revit?: string }>(xs: T[], n: string) => xs.find((x) => (x.name ?? x.revit) === n)!;

// ------------------------------------------------------------------ units, names, GUIDs

test("GDL numbers: 5 decimals, no trailing zeros, never -0", () => {
  assert.equal(F(1.2), "1.2");
  assert.equal(F(0.000001), "0");
  assert.equal(F(-0.0000001), "0");
  assert.equal(F(0.123456789), "0.12346");
  assert.equal(F(-2), "-2");
});

test("the MainGUID is the uuid5 fmc_gdl.py gave the operating light compiled in ArchiCAD 28", () => {
  // roundtrip XML in 04_Families\_Staging\_ArchiCAD (LP_XMLConverter libpart2xml, 19 Oct)
  assert.equal(objectGuid("FMC_E_LightFixture_OperatingLight_Ceiling_Detailed"), "6BED609D-8667-56F1-954D-FBEB860109A5");
});

test("GDL parameter names: letters, digits and _, 32 characters, unique, never a reserved name", () => {
  const used = new Set<string>();
  assert.equal(gdlName("Top Material", used), "Top_Material");
  assert.equal(gdlName("Top Material", used), "Top_Material_2");
  assert.equal(gdlName("A", used), "A_2");
  assert.equal(gdlName("3-way Valve", used), "p_3_way_Valve");
  assert.equal(gdlName("GLOB_SCALE", used), "p_GLOB_SCALE");
  const long = gdlName("A very long Revit parameter name that goes on and on", used);
  assert.ok(long.length <= 32, long);
});

test("Revit parameter types map to GDL types, and the ones GDL can't hold say why", () => {
  assert.deepEqual([mapParamType("Length").gdl, mapParamType("YesNo").gdl, mapParamType("Integer").gdl, mapParamType("Angle").gdl,
    mapParamType("Material").gdl, mapParamType("Text").gdl, mapParamType("NumberOfPoles").gdl], ["Length", "Boolean", "Integer", "Angle", "Material", "String", "Integer"]);
  assert.equal(mapParamType("Area").status, "partial");
  assert.equal(mapParamType("ApparentPower").gdl, "RealNum");
  assert.equal(mapParamType("ApparentPower").status, "partial");
  assert.equal(mapParamType("FamilyType").status, "unsupported");
  assert.match(mapParamType("FamilyType").note, /no family types/);
  assert.equal(mapParamType("Image").status, "unsupported");
  assert.equal(mapParamType("Gizmo").status, "unsupported");
});

test("formulas: parameter names and mm units translate; if() is refused with a reason", () => {
  const names = new Map([["Width", { gdl: "Width", type: "Length" as const }], ["Door Width", { gdl: "Door_Width", type: "Length" as const }],
    ["FMC_Design_Movement", { gdl: "FMC_Design_Movement", type: "Integer" as const }], ["Carcass Material", { gdl: "Carcass_Material", type: "Material" as const }]]);
  assert.deepEqual(translateFormula("Width - 4 mm", names, "Length"), { expr: "Width - 0.004" });
  assert.deepEqual(translateFormula("Width / 2", names, "Length"), { expr: "Width / 2" });
  assert.deepEqual(translateFormula("FMC_Design_Movement = 3", names, "Boolean"), { expr: "FMC_Design_Movement = 3" });
  assert.deepEqual(translateFormula("Carcass Material", names, "Material"), { expr: "Carcass_Material" });
  assert.match(translateFormula("Width + 40", names, "Length").reason!, /display units/);
  assert.equal(translateFormula("if(Width > 500 mm, 1, 0)", names, "Integer").expr, undefined);
  assert.match(translateFormula("Width * Unknown Thing", names, "Length").reason!, /isn't a mapped parameter/);
});

test("reference planes: plan lines give x or y, front-view lines give z, door templates give Left/Right/Head from the type", () => {
  const p = recipePlanes([
    { op: "add_ref_plane", name: "L", from: [-300, -1], to: [-300, 1] },
    { op: "add_ref_plane", name: "F", from: [-1, -50], to: [1, -50] },
    { op: "add_ref_plane", name: "Top", view: "Front", from: [-1, 900], to: [1, 900] },
    { op: "set_type_value", type: "T", param: "Width", value: 900 },
    { op: "set_type_value", type: "T", param: "Height", value: 2100 },
  ], "Metric Door.rft");
  assert.deepEqual(p.get("L"), { axis: "x", at: -300 });
  assert.deepEqual(p.get("F"), { axis: "y", at: -50 });
  assert.deepEqual(p.get("Top"), { axis: "z", at: 900 });
  assert.equal(p.get("Left")!.at, -450);
  assert.equal(p.get("Right")!.at, 450);
  assert.equal(p.get("Head")!.at, 2100);
  assert.match(p.get("Head")!.assumed!, /template plane/);
});

test("a sweep on path_planes: corners where planes cross, offsets move each segment's plane (FmcDocSweep)", () => {
  const planes = recipePlanes([
    { op: "set_type_value", type: "T", param: "Width", value: 900 }, { op: "set_type_value", type: "T", param: "Height", value: 2100 },
    { op: "add_ref_plane", name: "Wall Centre", from: [-1500, 0], to: [1500, 0] },
  ], "Metric Door.rft");
  const r = pathFromPlanes({ path_plane: "front", path_host: "Wall Centre", path_offsets: [20, -20, -20],
    path_planes: [["Left", "Ref. Level"], ["Left", "Head"], ["Right", "Head"], ["Right", "Ref. Level"]] }, planes, () => undefined);
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.deepEqual(r.path, [[-430, 0], [-430, 2080], [430, 2080], [430, 0]]);
  assert.equal(r.at, 0);
});

// ------------------------------------------------------------------ sample family 1: a simple table

test("simple table: every parameter, solid and material maps; the box is the table's size", () => {
  const { obj, xml, problems } = exportFamily({ recipe: read("FMC_I_Furniture_Table_Simple.recipe.json") }, kit);
  const r = obj.report;
  assert.deepEqual(problems, []);
  assert.deepEqual(r.size_mm, [1200, 800, 750]);
  assert.deepEqual(r.summary.geometry, { mapped: 6, partial: 0, unsupported: 0 });
  assert.equal(r.summary.parameters.unsupported, 0);
  assert.equal(row(r.geometry, "Top").gdl, "BLOCK");
  assert.equal(row(r.geometry, "Leg FL").gdl, "EXTRUDE");
  assert.equal(row(r.parameters, "Width").gdl_type, "Length");
  assert.equal(row(r.parameters, "Width").default, 1.2);
  assert.equal(row(r.parameters, "Show Modesty Panel").gdl, "Show_Modesty_Panel");
  assert.equal(row(r.parameters, "Description").builtin, true);
  assert.deepEqual(r.materials, [{ revit_param: "Top Material", kit_material: "FMC_Laminate_White", gdl: 'Top_Material (Material) + DEFINE MATERIAL "FMC_Laminate_White"', status: "mapped", note: "kit colour and finish inline" }]);
  assert.equal(r.types.count, 2);
  // the 3D script: kit surface inline, the switch and the detail level on the panel, the top as a BLOCK at the origin-shifted box
  assert.match(obj.s3d, /DEFINE MATERIAL "FMC_Laminate_White" 0, 0.94902/);
  assert.match(obj.s3d, /IF \(iLOD = 2 OR iLOD = 3\) AND Show_Modesty_Panel THEN/);
  assert.match(obj.s3d, /ADD 0.6, 0.4, 0\n/);
  assert.match(obj.s3d, /ADD -0.6, -0.4, 0.725\nBLOCK 1.2, 0.8, 0.025/);
  assert.match(obj.s3d, /IF bKitSurfaces THEN SET MATERIAL "FMC_Laminate_White" ELSE SET MATERIAL Top_Material/);
  // types: the parameter script sets the mapped values when fmcType changes
  assert.match(obj.spr, /VALUES "fmcType" "1200x800", "1600x800"/);
  assert.match(obj.spr, /IF fmcType = "1600x800" THEN PARAMETERS Width = 1.6, Depth = 0.8, Height = 0.75, Top_Thickness = 0.025, FMC_Keynote_Code = "I.FUR_10"/);
  // the XML: the sections LP_XMLConverter reads, the parameter script in Script_VL (PLAN_ARCHICAD finding 1)
  assert.match(xml, /<Script_VL SectVersion="20" SectionFlags="0" SubIdent="0">\n<!\[CDATA\[VALUES\{2\} "iLOD3D"/);
  assert.match(xml, /<Script_PR SectVersion="20" SectionFlags="0" SubIdent="0">\n<!\[CDATA\[\]\]>/);
  assert.match(xml, /<Length Name="A">\n\t\t\t<Description><!\[CDATA\["Width"\]\]><\/Description>\n\t\t\t<Fix\/>\n\t\t\t<Value>1.2<\/Value>/);
  assert.match(xml, /<Material Name="Top_Material">/);
  assert.match(xml, /<Boolean Name="Show_Modesty_Panel">/);
  assert.match(xml, new RegExp(`MainGUID="${objectGuid("FMC_I_Furniture_Table_Simple")}"`));
});

test("simple table: the parameter list carries name, type, default and the Revit parameter", () => {
  const { obj } = exportFamily({ recipe: read("FMC_I_Furniture_Table_Simple.recipe.json") }, kit);
  const list = paramList(obj);
  assert.deepEqual(list.find((p) => p.name === "Top_Thickness"), { name: "Top_Thickness", type: "Length", default: 0.025, description: "Top Thickness", revit: "Top Thickness" });
  assert.deepEqual(list.slice(0, 3).map((p) => [p.name, p.default]), [["A", 1.2], ["B", 0.8], ["ZZYZX", 0.75]]);
  assert.ok(!list.some((p) => p.type === "Title"));
});

// ------------------------------------------------------------------ sample family 2: casework with a door

test("casework unit: void cut, shelves array, coarse envelope, plan swing, formulas and types", () => {
  const { obj, problems } = exportFamily({ recipe: read("FMC_I_Casework_BaseUnit_Door.recipe.json") }, kit);
  const r = obj.report;
  assert.deepEqual(problems, []);
  assert.deepEqual(r.size_mm, [600, 578, 870]);
  assert.equal(row(r.geometry, "Handle Recess").gdl, "GROUP + SUBGROUP (boolean cut)");
  assert.equal(row(r.geometry, "Door").gdl, "EXTRUDE minus voids");
  assert.equal(row(r.geometry, "Shelf").gdl, "EXTRUDE in a FOR loop");
  assert.equal(row(r.geometry, "Carcass").gdl, "BLOCK");
  assert.match(obj.s3d, /PLACEGROUP SUBGROUP\("g_Door", "g_Door_v0"\)/);
  assert.match(obj.s3d, /FOR fmcK = 0 TO MIN\(Shelf_Count, 2\) - 1\n\t\tADDZ 0.25 \* fmcK/);
  assert.match(obj.s3d, /IF \(iLOD = 1\) THEN\n\t! Coarse Envelope/);
  assert.match(obj.s3d, /IF \(iLOD = 3\) THEN\n\t! Shelf/);
  assert.match(obj.s3d, /ROTX 90\n\s*ADDZ 0.56/, "the door is drawn in the front sketch");
  assert.match(obj.s2d, /ARC2 0.002, 0, 0.596, 270, 360  ! Door swing/);
  assert.match(obj.s2d, /LINE2 0.002, 0, 0.002, -0.596/);
  assert.equal(row(r.parameters, "Door Width").formula_gdl, "Width - 0.004");
  assert.equal(row(r.parameters, "Door Material").formula_gdl, "Carcass_Material");
  assert.match(obj.master, /Door_Width = Width - 0.004/);
  assert.match(obj.spr, /Door_Width = Width - 0.004\nPARAMETERS Door_Width = Door_Width\nLOCK "Door_Width"/);
  assert.equal(row(r.parameters, "Door Swing").gdl_type, "Angle");
  assert.equal(row(r.parameters, "Door Area").status, "partial");
  assert.equal(row(r.parameters, "FMC_Unit_Price").gdl_type, "RealNum");
  assert.equal(row(r.subcategories, "Coarse Envelope").status, "mapped");
  assert.equal(row(r.subcategories, "Carcass").status, "partial");
  assert.ok(r.materials.some((m) => m.revit_param === "Door Material" && m.status === "partial"), "Door Material has no kit material of its own");
  assert.equal(r.constraints_frozen.lock_face, 1);
});

// ------------------------------------------------------------------ sample family 3: what GDL can't carry

test("unsupported features are each named with a reason, and the rest still exports", () => {
  const { obj, xml, problems } = exportFamily({ recipe: read("FMC_Z_Test_Unsupported.recipe.json") }, kit);
  const r = obj.report;
  assert.deepEqual(problems, []);
  const g = (n: string) => row(r.geometry, n);
  assert.equal(g("Body").status, "mapped");
  assert.equal(g("Sill Box").status, "unsupported");
  assert.match(g("Sill Box").reason, /Sill/);
  assert.equal(g("Arc Plate").status, "unsupported");
  assert.match(g("Arc Plate").reason, /arcs or splines/);
  assert.equal(g("Taper Odd").status, "unsupported");
  assert.match(g("Taper Odd").reason, /4 points and top 3/);
  assert.equal(g("Taper Even").gdl, "RULED");
  assert.equal(g("Half Knob").status, "partial");
  assert.match(g("Profiled Trim").reason, /profile family FMC_Profile_Architrave_Greek/);
  assert.match(g("Trim To Template Plane").reason, /"Left" comes from the template/);
  assert.match(g("Spout").reason, /swept blend/);
  assert.equal(g("Lonely Void").gdl, "nothing (the void cuts no solid)");
  const p = (n: string) => row(r.parameters, n);
  assert.equal(p("Handle Type").status, "unsupported");
  assert.equal(p("Handle Type").gdl, undefined);
  assert.equal(p("Product Image").status, "unsupported");
  assert.equal(p("Spin").status, "unsupported");
  assert.equal(p("Load").status, "partial");
  assert.match(p("Is Wide").note, /formula not carried: uses if\(\)/);
  const o = (n: string) => row(r.other, n);
  assert.equal(o("Water Point").status, "unsupported");
  assert.match(o("Water Point").reason, /nested family/);
  assert.equal(o("Power").gdl, "HOTSPOT");
  assert.match(o("Power").reason, /AC2a/);
  assert.equal(o("Ghost").gdl, undefined);
  assert.equal(o("Front opening").status, "unsupported");
  assert.equal(o("Swing on planes").status, "unsupported");
  assert.equal(o("FMC_P_PlumbingEq_ServicePoint_Water").status, "partial");
  // placeholders: the nested family and the connector are hotspots in the 3D script
  assert.match(obj.s3d, /HOTSPOT .*! nested family: Water Point/);
  assert.match(obj.s3d, /HOTSPOT 0.2, 0.3, 0.3  ! connector: Power/);
  assert.ok(!xml.includes("Handle_Type"));
  assert.ok(r.summary.geometry.unsupported >= 6);
});

// ------------------------------------------------------------------ an fmc_doc report (a family opened in staging)

test("an fmc_doc report: forms as their boxes (partial), parameters without types as String, nested as a hotspot", () => {
  const { model, obj, problems } = exportFamily({ report: read("FMC_I_Casework_BaseUnit_Door.fmcdoc_report.json") }, kit);
  assert.deepEqual(problems, []);
  assert.equal(model.family, "FMC_I_Casework_BaseUnit_Door");
  const r = obj.report;
  assert.match(row(r.geometry, "Handle").gdl, /^BLOCK \(bounding box\)/);
  assert.equal(row(r.geometry, "Handle").status, "partial");
  assert.equal(row(r.geometry, "Broken").status, "unsupported");
  assert.equal(row(r.geometry, "Handle Recess").gdl, "GROUP + SUBGROUP (boolean cut)");
  assert.equal(row(r.parameters, "Width").gdl_type, "String");
  assert.equal(row(r.parameters, "Width").status, "partial");
  assert.equal(row(r.parameters, "Shelf Count").gdl_type, "Integer");
  assert.equal(row(r.other, "FMC_I_Hardware_Hinge").status, "unsupported");
  assert.match(r.notes[0], /bounding box/);
  assert.deepEqual(r.size_mm, [600, 600, 770]);
  assert.match(toXml(obj), /VALUES "fmcType" "600", "450"/);
});

// ------------------------------------------------------------------ every kit recipe in the repo

test("every recipe in tests/recipes exports a structurally sound XML, and every solid has a status and a reason", () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".recipe.json") ? [path.join(d, e.name)] : []);
  const files = walk(path.join(REPO, "tests", "recipes"));
  assert.ok(files.length >= 20, `${files.length} recipes`);
  for (const f of files) {
    const recipe = JSON.parse(fs.readFileSync(f, "utf8"));
    const { model, obj, problems } = exportFamily({ recipe });
    assert.deepEqual(problems, [], path.basename(f));
    const solids = model.solids.length;
    assert.equal(obj.report.geometry.length, solids, `${path.basename(f)}: one geometry row per solid`);
    for (const g of obj.report.geometry) assert.ok(g.reason.length > 0 || g.status === "mapped", `${path.basename(f)} ${g.name}`);
  }
});

test("the ICU bed recipe (one of the four objects compiled on 19 Oct) maps every solid", () => {
  const recipe = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "recipes", "healthcare", "FMC_I_MedEq_Bed_ICU_Electric.recipe.json"), "utf8"));
  const { obj } = exportFamily({ recipe });
  assert.equal(obj.report.summary.geometry.unsupported, 0);
  assert.ok(obj.report.summary.geometry.mapped >= 30);
  assert.match(obj.s3d, /REVOLVE/);
});

test("checkXml catches a broken object", () => {
  const { xml } = exportFamily({ recipe: read("FMC_I_Furniture_Table_Simple.recipe.json") }, kit);
  assert.deepEqual(checkXml(xml), []);
  assert.ok(checkXml(xml.replace("</Script_3D>", "")).some((p) => /Script_3D/.test(p)));
  assert.ok(checkXml(xml.replace('LOCK "A", "B", "ZZYZX"', 'LOCK "A", "Nope"')).some((p) => /LOCK names Nope/.test(p)));
  assert.ok(checkXml(xml.replace("\nENDIF\n", "\n")).some((p) => /IF\/ENDIF/.test(p)));
});

// ------------------------------------------------------------------ the tool: dry run, writes, refusals

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-archicad-"));
  const out = path.join(root, "gdl_out");
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [out], reports_dir: path.join(root, "reports"), materials_file: path.join(FIX, "FMC_Materials.sample.json"), family_staging_root: "" };
  return { root, out, config };
}
const args = (a: Record<string, unknown>) => z.object(FMC_ARCHICAD_SHAPE).parse(a);
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

test("fmc_archicad map: the dry run reports and writes nothing", async () => {
  const s = sandbox();
  const r = await runFmcArchicad(args({ action: "map", recipe_file: path.join(FIX, "FMC_Z_Test_Unsupported.recipe.json") }), { config: s.config });
  assert.equal(r.isError, false);
  const b = body(r);
  assert.equal(b.dry_run, true);
  assert.equal(b.xml_check, "ok (structure; LP_XMLConverter not run)");
  assert.ok(b.report.geometry.every((g: { status: string }) => g.status !== "mapped"), "only rows that aren't fully mapped by default");
  assert.equal(fs.existsSync(s.out), false);
  const full = body(await runFmcArchicad(args({ action: "map", full: true, recipe_file: path.join(FIX, "FMC_Z_Test_Unsupported.recipe.json") }), { config: s.config }));
  assert.ok(full.report.geometry.some((g: { status: string }) => g.status === "mapped"));
});

test("fmc_archicad export: dry run lists the files; dry_run false writes XML, scripts, parameter list and report", async () => {
  const s = sandbox();
  const recipe = path.join(FIX, "FMC_I_Furniture_Table_Simple.recipe.json");
  const dry = body(await runFmcArchicad(args({ action: "export", recipe_file: recipe, out_dir: s.out }), { config: s.config }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.would_write.length, 8);
  assert.equal(fs.existsSync(s.out), false);
  const r = await runFmcArchicad(args({ action: "export", recipe_file: recipe, out_dir: s.out, dry_run: false }), { config: s.config });
  assert.equal(r.isError, false, r.content[0].text);
  const dir = path.join(s.out, "FMC_I_Furniture_Table_Simple");
  for (const f of ["FMC_I_Furniture_Table_Simple.xml", "FMC_I_Furniture_Table_Simple.params.json", "FMC_I_Furniture_Table_Simple.mapping.json",
    path.join("scripts", "3d.gdl"), path.join("scripts", "2d.gdl"), path.join("scripts", "master.gdl"), path.join("scripts", "parameter.gdl"), path.join("scripts", "ui.gdl")])
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(fs.existsSync(path.join(dir, "build_gsm.cmd")), false, "no converter script unless asked");
  assert.deepEqual(checkXml(fs.readFileSync(path.join(dir, "FMC_I_Furniture_Table_Simple.xml"), "utf8")), []);
  assert.ok(fs.readFileSync(path.join(s.config.reports_dir, "FMC_MCP_FileLog.csv"), "utf8").includes("fmc_archicad export"));
});

test("fmc_archicad export: converter_path only writes build_gsm.cmd, never runs it", async () => {
  const s = sandbox();
  const r = body(await runFmcArchicad(args({ action: "export", recipe_file: path.join(FIX, "FMC_I_Casework_BaseUnit_Door.recipe.json"), out_dir: s.out, dry_run: false,
    converter_path: "C:\\Program Files\\GRAPHISOFT\\ARCHICAD 28\\LP_XMLConverter.exe" }), { config: s.config }));
  const cmd = fs.readFileSync(path.join(s.out, "FMC_I_Casework_BaseUnit_Door", "build_gsm.cmd"), "utf8");
  assert.match(cmd, /LP_XMLConverter.exe" xml2libpart "%~dp0FMC_I_Casework_BaseUnit_Door.xml"/);
  assert.equal(fs.existsSync(path.join(s.out, "FMC_I_Casework_BaseUnit_Door", "FMC_I_Casework_BaseUnit_Door.gsm")), false);
  assert.match(r.next, /by hand/);
});

test("fmc_archicad refuses: an .rfa, two sources, a folder outside the write roots, the source's own folder", async () => {
  const s = sandbox();
  const rfa = body(await runFmcArchicad(args({ action: "map", family_file: "Z:\\x\\FMC_A.rfa" }), { config: s.config }));
  assert.equal(rfa.refused, true);
  assert.match(rfa.reasons.join(" "), /fmc_doc report/);
  const two = body(await runFmcArchicad(args({ action: "map", recipe_file: "a.json", report_file: "b.json" }), { config: s.config }));
  assert.equal(two.refused, true);
  const outside = await runFmcArchicad(args({ action: "export", recipe_file: path.join(FIX, "FMC_I_Furniture_Table_Simple.recipe.json"), out_dir: path.join(s.root, "elsewhere"), dry_run: false }), { config: s.config });
  assert.equal(outside.isError, true);
  assert.match(body(outside).reasons.join(" "), /allowed write folder/);
  assert.equal(fs.existsSync(path.join(s.root, "elsewhere")), false);
  // the fixture folder as a write root, and out_dir the fixtures' own folder: refused as "next to the source"
  const next = await runFmcArchicad(args({ action: "export", recipe_file: path.join(FIX, "FMC_I_Furniture_Table_Simple.recipe.json"), out_dir: FIX, dry_run: false }),
    { config: { ...s.config, write_roots: [FIX] } });
  assert.equal(next.isError, true);
  assert.match(body(next).reasons.join(" "), /next to the source/);
  assert.equal(fs.existsSync(path.join(FIX, "FMC_I_Furniture_Table_Simple")), false);
});

test("fmc_archicad export from an fmc_doc report writes the box object", async () => {
  const s = sandbox();
  const r = await runFmcArchicad(args({ action: "export", report_file: path.join(FIX, "FMC_I_Casework_BaseUnit_Door.fmcdoc_report.json"), out_dir: s.out, dry_run: false }), { config: s.config });
  assert.equal(r.isError, false, r.content[0].text);
  assert.ok(fs.existsSync(path.join(s.out, "FMC_I_Casework_BaseUnit_Door", "FMC_I_Casework_BaseUnit_Door.xml")));
});

test("buildGdl without kit materials still defines a stand-in surface and says so", () => {
  const obj = buildGdl(recipeModel(read("FMC_I_Furniture_Table_Simple.recipe.json")));
  assert.equal(obj.report.materials[0].status, "partial");
  assert.match(obj.s3d, /DEFINE MATERIAL "FMC_Laminate_White" 0, 0.70588/);
  assert.equal(reportModel({}).family, "Unnamed");
});
