import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecipe, stagingPath, type Recipe } from "./recipes.js";
import { DEFAULT_CONFIG } from "./policy.js";
import { saveProblems } from "./doc.js";
import {
  FAMILY_TEMPLATES, allFamilyTemplateRecipes, familyTemplateRecipe, familyTemplateStagingPath,
  isFamilyTemplateRecipe, isFamilyTemplateSavePath, rebaseOnFamilyTemplate, recipeStagingPath,
  sourceTemplateOf, specForSource, setupKey,
} from "./familytemplates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const recipeDir = path.resolve(here, "../../../tests/recipes/_family_templates");

const doorFamily = (): Recipe => parseRecipe(JSON.stringify({
  schema: "fmc-recipe/0.1",
  family: "FMC_A_Door_Sample",
  template: "Metric Door.rft",
  about: "Sample door used to prove B3 rebasing.",
  ops: [
    { op: "set_category", name: "OST_Doors" },
    { op: "add_type", name: "0900x2100" },
    { op: "set_type_value", name: "0900x2100/Width", type: "0900x2100", param: "Width", value: 900 },
    { op: "add_shared_param", name: "FMC_Keynote_Code", guid: "2d089b32-0589-516b-8952-9f6afad95971", group: "IdentityData" },
    { op: "add_shared_param", name: "FMC_Frame_Spec", guid: "7a163363-b62c-57f9-8d75-66d6b9aad4c6" },
    { op: "add_shared_param", name: "FMC_Geometry_Stage", guid: "27c3be4d-9757-51ba-aa96-6c7a3a061025" },
    { op: "add_shared_param", name: "IfcExportAs", guid: "bae7a5f9-3ec7-57e3-ba6b-bcd858fd95f7" },
    { op: "add_subcategory", name: "Frame", line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0] },
    { op: "add_ref_plane", name: "Leaf Left", from: [-410, -1000], to: [-410, 1000], is_reference: "WeakReference" },
  ],
})).recipe!;

test("B3 names the eight FMC templates from the plan, each from a metric .rft", () => {
  assert.equal(FAMILY_TEMPLATES.length, 8);
  assert.deepEqual(FAMILY_TEMPLATES.map((s) => s.family), [
    "FMC_GenericModel", "FMC_GenericModel_FaceBased", "FMC_ElectricalFixture_FaceBased",
    "FMC_LightingFixture", "FMC_PlumbingFixture", "FMC_MechanicalEquipment", "FMC_Door", "FMC_Window",
  ]);
  assert.equal(specForSource("Metric Door.rft")?.family, "FMC_Door");
  assert.equal(sourceTemplateOf("FMC_Door.rft"), "Metric Door.rft");
  assert.equal(sourceTemplateOf("FMC_Window.rft"), "Metric Window.rft");
  assert.equal(sourceTemplateOf("Metric Door.rft"), undefined);
});

test("each template recipe parses as fmc-recipe/0.1 and is marked family_template", () => {
  for (const recipe of allFamilyTemplateRecipes()) {
    const parsed = parseRecipe(JSON.stringify(recipe));
    assert.equal(parsed.problems.join("; "), "");
    assert.ok(parsed.recipe);
    assert.equal(parsed.recipe!.kind, "family_template");
    assert.ok(isFamilyTemplateRecipe(parsed.recipe!));
    assert.ok(parsed.recipe!.ops.some((o) => o.op === "add_shared_param" && o.name === "FMC_Keynote_Code"));
    assert.ok(parsed.recipe!.ops.some((o) => o.op === "add_shared_param" && o.name === "IfcExportAs"));
    assert.ok(parsed.recipe!.ops.some((o) => o.op === "add_shared_param" && o.name === "FMC_Geometry_Stage"));
  }
  const door = familyTemplateRecipe(FAMILY_TEMPLATES.find((s) => s.family === "FMC_Door")!);
  assert.ok(door.ops.some((o) => o.op === "set_category" && o.name === "OST_Doors"));
  assert.ok(door.ops.some((o) => o.op === "add_subcategory" && o.name === "Frame"));
  assert.match(door.about, /0900x2100/);
});

test("the checked-in FamilyTemplates recipes match the catalog", () => {
  assert.ok(fs.existsSync(recipeDir), `missing ${recipeDir}`);
  const files = fs.readdirSync(recipeDir).filter((f) => f.endsWith(".recipe.json")).sort();
  assert.deepEqual(files, FAMILY_TEMPLATES.map((s) => s.family + ".recipe.json"));
  for (const spec of FAMILY_TEMPLATES) {
    const raw = fs.readFileSync(path.join(recipeDir, spec.family + ".recipe.json"), "utf8");
    const parsed = parseRecipe(raw);
    assert.equal(parsed.problems.join("; "), "", spec.family);
    const expected = familyTemplateRecipe(spec);
    assert.equal(parsed.recipe!.template, expected.template);
    assert.equal(parsed.recipe!.kind, "family_template");
    assert.deepEqual(parsed.recipe!.ops, expected.ops);
  }
});

test("staging for a family template is .rft under _FamilyTemplates, still inside the staging root", () => {
  const root = "Z:\\00_Standards\\04_Families\\_Staging";
  const door = familyTemplateRecipe(FAMILY_TEMPLATES.find((s) => s.family === "FMC_Door")!);
  assert.equal(familyTemplateStagingPath(root, "FMC_Door"), "Z:\\00_Standards\\04_Families\\_Staging\\_FamilyTemplates\\FMC_Door.rft");
  assert.equal(recipeStagingPath(root, door, stagingPath), "Z:\\00_Standards\\04_Families\\_Staging\\_FamilyTemplates\\FMC_Door.rft");
  const family = doorFamily();
  assert.equal(recipeStagingPath(root, family, stagingPath), stagingPath(root, family.family));
  assert.match(recipeStagingPath(root, family, stagingPath), /\\A\\FMC_A_Door_Sample\.rfa$/);
});

test("rebasing a door recipe onto FMC_Door.rft drops setup ops and keeps geometry and family-specific parameters", () => {
  const original = doorFamily();
  const template = familyTemplateRecipe(FAMILY_TEMPLATES.find((s) => s.family === "FMC_Door")!);
  const { recipe, removed, problems } = rebaseOnFamilyTemplate(original, template);
  assert.deepEqual(problems, []);
  assert.equal(recipe.template, "FMC_Door.rft");
  assert.ok(removed >= 5, `expected several setup ops removed, got ${removed}`);
  assert.ok(recipe.ops.length < original.ops.length);
  assert.ok(recipe.ops.some((o) => o.op === "add_type" && o.name === "0900x2100"));
  assert.ok(recipe.ops.some((o) => o.op === "add_shared_param" && o.name === "FMC_Frame_Spec"));
  assert.ok(recipe.ops.some((o) => o.op === "add_ref_plane" && o.name === "Leaf Left"));
  assert.ok(!recipe.ops.some((o) => o.op === "set_category"));
  assert.ok(!recipe.ops.some((o) => o.op === "add_shared_param" && o.name === "FMC_Keynote_Code"));
  assert.ok(!recipe.ops.some((o) => o.op === "add_subcategory" && o.name === "Frame"));
  // leftover ops plus template setup cover the original setup; leftover stay in order
  const origSetup = original.ops.map((o) => setupKey(o as Record<string, unknown>)).filter((k): k is string => !!k);
  const afterSetup = recipe.ops.map((o) => setupKey(o as Record<string, unknown>)).filter((k): k is string => !!k);
  const templateSetup = template.ops.map((o) => setupKey(o as Record<string, unknown>)).filter((k): k is string => !!k);
  for (const key of origSetup) assert.ok(templateSetup.includes(key) || afterSetup.includes(key), key);
  const leftover = original.ops.filter((o) => {
    const key = setupKey(o as Record<string, unknown>);
    return !(key && templateSetup.includes(key));
  });
  assert.deepEqual(recipe.ops, leftover);
});

test("rebase refuses a family recipe whose template does not match the FMC source", () => {
  const original = doorFamily();
  original.template = "Metric Window.rft";
  const template = familyTemplateRecipe(FAMILY_TEMPLATES.find((s) => s.family === "FMC_Door")!);
  const { problems, removed } = rebaseOnFamilyTemplate(original, template);
  assert.equal(removed, 0);
  assert.match(problems.join(" "), /does not match/);
});

test("save allows an FMC .rft only under _FamilyTemplates inside a write root; overwrite is still the caller's check", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    write_roots: ["D:\\Kit\\04_Families\\_Staging", "D:\\Kit\\04_Families\\_ChainTests"],
    family_staging_root: "D:\\Kit\\04_Families\\_Staging",
  };
  const ok = "D:\\Kit\\04_Families\\_Staging\\_FamilyTemplates\\FMC_Door.rft";
  assert.equal(isFamilyTemplateSavePath(ok), true);
  assert.deepEqual(saveProblems(ok, cfg), []);
  assert.match(saveProblems("D:\\Kit\\04_Families\\_Staging\\A\\FMC_Door.rft", cfg)[0], /family template[\s\S]*_FamilyTemplates|_FamilyTemplates/);
  assert.match(saveProblems("D:\\Kit\\04_Families\\_Staging\\_FamilyTemplates\\Door.rft", cfg)[0], /family template|_FamilyTemplates|FMC_/);
  assert.ok(saveProblems("C:\\Temp\\_FamilyTemplates\\FMC_Door.rft", cfg).some((r) => /Not inside an allowed write folder/.test(r)));
  assert.match(saveProblems("D:\\Kit\\04_Families\\_Staging\\_FamilyTemplates\\FMC_Door.rvt", cfg)[0], /saved as \.rfa/);
});
