import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryNameProblem, suggestToken } from "./categorynames.js";

test("VE-4/MQ-3: names that are not OST_ tokens are refused by name, never read as every category", () => {
  assert.equal(categoryNameProblem(["OST_Walls", "OST_Doors"], "categoryFilters"), null);
  assert.equal(categoryNameProblem([], "categoryFilters"), null);
  assert.equal(categoryNameProblem(undefined, "categoryFilters"), null);
  const bad = categoryNameProblem(["Walls", "OST_Floors", "structural framing"], "modelCategoryList");
  assert.equal(bad?.code, "FMC-CATEGORY-UNKNOWN");
  assert.deepEqual(bad?.not_parsed, ["Walls", "structural framing"]);
  assert.deepEqual(bad?.try, ["OST_Walls", "OST_StructuralFraming"]);
  assert.match(bad?.message ?? "", /not an unfiltered list/);
  assert.equal(suggestToken("ost_doors"), "OST_Doors");
});
