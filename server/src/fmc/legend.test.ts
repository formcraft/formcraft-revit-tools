import { test } from "node:test";
import assert from "node:assert/strict";
import { chainTestsRoot, roleTemplate } from "../tools/fmc_legend.js";

test("F-064 #6: the chain test uses the role's template from 06_Templates\\_Staging and saves in _ChainTests", () => {
  const have = new Set(["K:\\06_Templates\\_Staging\\FMC_E_Template_v2.2.rte", "K:\\06_Templates\\FMC_A_Template_v2.2.rte"]);
  const roots = ["C:\\ProgramData\\Autodesk\\RVT 2025\\Templates", "K:\\06_Templates"];
  assert.equal(roleTemplate(roots, "E", (f) => have.has(f)), "K:\\06_Templates\\_Staging\\FMC_E_Template_v2.2.rte");
  assert.equal(roleTemplate(roots, "A", (f) => have.has(f)), "K:\\06_Templates\\FMC_A_Template_v2.2.rte");
  assert.equal(roleTemplate(roots, "M", (f) => have.has(f)), null);
  assert.equal(chainTestsRoot(["K:\\04_Families\\_Staging", "K:\\04_Families\\_ChainTests"], "K:\\04_Families\\_Staging"), "K:\\04_Families\\_ChainTests");
  assert.equal(chainTestsRoot([], "K:\\04_Families\\_Staging\\"), "K:\\04_Families\\_ChainTests");
});
