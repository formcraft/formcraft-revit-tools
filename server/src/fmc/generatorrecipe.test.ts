// N064 (L003-F509 "generator recipe broken"): both generator recipes in the repo check clean against the kit subset.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecipe } from "./recipes.js";
import { opsProblems, splitProblems } from "./ops.js";
import { parseSharedParameters } from "./specs.js";
import { parseMaterialDb } from "./materials.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const recipes = path.resolve(here, "..", "..", "..", "tests", "recipes", "healthcare");
const gen = path.join(recipes, "generator");
const read = (f: string) => fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
const dictionary = parseSharedParameters(read(path.join(gen, "kit_subset.FMC_SharedParameters.txt")));
const materials = parseMaterialDb(JSON.parse(read(path.join(gen, "kit_subset.FMC_Materials.json"))));
const FAMILIES = "D:\\Fomcraft\\FMC_BIM_27\\FMC_Kit_v2.2\\FMC_Kit_v2.2\\04_Families";

for (const [label, file] of [["the 6 Nov repaired recipe (envelope, visibility_tier, set_line_weight)", path.join(gen, "FMC_E_EQ_Generator_Diesel_Standby.recipe.json")],
  ["the products recipe (one material per kit name)", path.join(recipes, "products", "FMC_E_EQ_Generator_Diesel_Standby.recipe.json")]] as const) {
  test(`generator recipe parses and checks clean: ${label}`, () => {
    const { recipe, problems } = parseRecipe(read(file));
    assert.ok(recipe, problems.join("\n"));
    assert.equal(recipe!.family, "FMC_E_EQ_Generator_Diesel_Standby");
    const { errors } = splitProblems(opsProblems(recipe!.ops, dictionary, FAMILIES, materials, { template: path.win32.basename(recipe!.template) }));
    assert.deepEqual(errors, []);
  });
}

test("the repaired recipe uses the three N064 ops (so this test guards the port)", () => {
  const ops = (JSON.parse(read(path.join(gen, "FMC_E_EQ_Generator_Diesel_Standby.recipe.json"))).ops as Array<{ op: string }>).map((o) => o.op);
  for (const op of ["envelope", "visibility_tier", "set_line_weight"]) assert.ok(ops.includes(op), op);
});

test("the products recipe adds each kit material once", () => {
  const ops = JSON.parse(read(path.join(recipes, "products", "FMC_E_EQ_Generator_Diesel_Standby.recipe.json"))).ops as Array<{ op: string; name: string }>;
  const names = ops.filter((o) => o.op === "add_material").map((o) => o.name);
  assert.equal(new Set(names).size, names.length);
});
