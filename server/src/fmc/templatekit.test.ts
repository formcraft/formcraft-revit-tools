import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseRecipe, expectedNames, lineSegments, scaleOf, translateRule } from "./templatekit.js";

// The kit's tabs (a snapshot of FMC_Revit_Kit.xlsx v2.2) read by the plugin must give what the hand build of 14 Oct
// gave: those specs built a Base template that passed its audit with 0 warnings in Revit 2025.
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/fmc/fixtures");
const tabs = JSON.parse(fs.readFileSync(path.join(FIX, "revit_kit_tabs.json"), "utf8")).tabs as Record<string, string[][]>;
const sheets = new Map(Object.entries(tabs));
const master = { params: { FMC_Project_Code: { binding: "Project Information", categories: ["OST_ProjectInformation"], group: "FMC_01_Project_Governance" },
  FMC_Keynote_Code: { binding: "Type", categories: ["OST_Walls"], group: "FMC_17_Element_Code_Keynote" } } };
const recipe = baseRecipe("FMC_Kit v2.2", sheets, master);
const hand = (f: string) => fs.readFileSync(path.join(FIX, "handbuild_" + f), "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("|"));

test("every filter rule reads the way the hand build read it", () => {
  const expected = hand("FMC_Filters_build.txt");
  assert.equal(recipe.filters.length, expected.length);
  for (const [name, cats, rule] of expected) {
    const f = recipe.filters.find((x) => x.name === name)!;
    assert.ok(f, name);
    assert.equal(f.rule, rule, name);
    assert.deepEqual(f.categories, cats === "5D" ? ["5D"] : cats.split(","), name);
  }
});

test("filter colours, patterns and surface or line match the hand build", () => {
  for (const [name, rgb, pattern, kind] of hand("FMC_FilterStyle_build.txt")) {
    const f = recipe.filters.find((x) => x.name === name)!;
    assert.equal(f.rgb.join(","), rgb, name);
    assert.equal(f.pattern, pattern, name);
    assert.equal(f.surface, kind === "S", name);
  }
});

test("view templates match the hand build; the only difference is a stated reading of 'Discipline colour filters'", () => {
  const expected = hand("FMC_VT_build.txt");
  assert.equal(recipe.view_templates.length, expected.length);
  for (const [name, type, scale, detail, discipline, filters] of expected) {
    const v = recipe.view_templates.find((x) => x.name === name)!;
    assert.ok(v, name);
    assert.deepEqual([v.type, String(v.scale), v.detail, v.discipline], [type, scale, detail, discipline], name);
    if (name === "VT_Z_3D_Coordination") continue; // read by a stated rule (see the note); the hand build added F_P_Sanitary
    assert.deepEqual(v.filters, filters ? filters.split(";") : [], name);
  }
  assert.ok(recipe.notes.some((n) => n.includes("Discipline colour filters")));
});

test("line patterns read from the kit's words", () => {
  const s = (t: string) => lineSegments(t).map((x) => (x.kind === "dash" ? `D${x.mm}` : x.kind === "space" ? `S${x.mm}` : ".")).join(" ");
  assert.equal(s("3 mm dash, 1.5 mm space"), "D3 S1.5");
  assert.equal(s("6 dash, 1.5 space, dot"), "D6 S1.5 . S1.5");
  assert.equal(s("6 dash, dot, dot"), "D6 S1.5 . S1.5 . S1.5");
  assert.equal(s("Dot 1.5 mm"), ". S1.5");
  assert.equal(s("12 dash, 3 dash"), "D12 S1.5 D3 S1.5");
  assert.equal(s("12 dash, 3 dot"), "D12 S1.5 . S1.5 . S1.5 . S1.5");
  assert.equal(recipe.graphics.lines.length, 6);
  assert.deepEqual(recipe.graphics.text.find((t) => t.name === "FMC_Arial_5.0_Bold"), { name: "FMC_Arial_5.0_Bold", font: "Arial", size_mm: 5, bold: true });
});

test("fills, electrical settings and system types come from the kit; demand factors never", () => {
  const fill = (n: string) => recipe.graphics.fills.find((f) => f.name === n);
  assert.deepEqual(fill("FMC_Blockwork"), { name: "FMC_Blockwork", target: "Drafting", kind: "hatch", angle: 45, spacing_mm: 3 });
  assert.equal(fill("FMC_Tile_600")!.spacing_mm, 600);
  assert.equal(fill("FMC_Concrete")!.copy_of, "Concrete");
  assert.equal(recipe.electrical.voltages.length, 4);
  assert.deepEqual(recipe.electrical.systems.find((x) => x.name === "DS_240V_1Ph_2W"), { name: "DS_240V_1Ph_2W", phase: "Single", config: "Undefined", wires: 2, ll: null, lg: "240 V" });
  assert.equal(recipe.electrical.loads.length, 8);
  assert.ok(!JSON.stringify(recipe.electrical).includes("0.33"), "no demand factor travels to Revit");
  assert.deepEqual(recipe.systems.piping.map((p) => p.name).sort(), ["FP_Wet", "L_Irrigation", "M_Condensate", "M_Refrigerant", "P_RWH", "P_Storm"]);
  assert.deepEqual(recipe.systems.duct, [{ name: "Outdoor Air", from: "SupplyAir" }]);
});

test("schedules 00-09 with their fields, groups and the gaps said plainly", () => {
  assert.deepEqual(recipe.schedules.map((s) => s.name), ["00_Codes_Used", "01_Types_Without_Code", "02_Walls", "03_Doors", "04_Windows", "05_Room_Finishes",
    "06_Floors", "07_Cost_Estimate", "08_Procurement_Status", "09_QA_MissingData"]);
  const w = recipe.schedules.find((s) => s.name === "02_Walls")!;
  assert.deepEqual(w.ops, ["g:Type", "g:Base Constraint"]);
  assert.deepEqual(recipe.schedules.find((s) => s.name === "01_Types_Without_Code")!.ops, ["none:FMC_Keynote_Code"]);
  assert.equal(recipe.schedules.find((s) => s.name === "00_Codes_Used")!.itemized, false);
  assert.ok(recipe.notes.some((n) => n.startsWith("09_QA_MissingData") && n.includes("OR filter")));
  assert.ok(recipe.notes.some((n) => n.startsWith("07_Cost_Estimate") && n.includes("amount (calculated)")));
});

test("rule wording the plugin can't map becomes category-only, with the reason", () => {
  assert.equal(translateRule("Load Classification contains Power", ["OST_Wire"]).rule, "none");
  assert.match(translateRule("Load Classification contains Power", ["OST_Wire"]).note!, /no Revit parameter/);
  assert.equal(scaleOf("1:10-1:20"), 20);
  assert.equal(scaleOf("NTS"), 0);
  assert.deepEqual(recipe.tbc, ["FMC_Project_Code"]);
  assert.equal(expectedNames(recipe).filters.length, 42);
});
