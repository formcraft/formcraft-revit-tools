import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRecipes, lookup, relatedStandards, resolve, suggestRecipe } from "./standards.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kit = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "..", "docs", "kit-proposals", "FMC_Standards_Building.json"), "utf8"));

test("standards (owner 26 Oct): kit values by use, the project's on top, each with its source and status", () => {
  const all = resolve(kit, { "levels.floor_to_floor": 3400 }, "residential");
  const ftf = lookup(all, "levels.floor_to_floor")[0];
  assert.deepEqual([ftf.value, ftf.source, ftf.status], [3400, "project", "project"]);
  const riser = lookup(all, "stairs.riser_max")[0];
  assert.deepEqual([riser.value, riser.source, riser.status], [190, "kit", "proposed"]);
  assert.equal(lookup(resolve(kit, null, "office"), "stairs.riser_max")[0].value, 170);
  assert.ok(lookup(all, "stairs").length >= 6, "a topic gives every value under it");
  assert.equal(lookup(all, "walls external")[0].kit_code, "B.200_00");
});

test("recipes: found by words; when none fits, the name to write and the standards to build it from", () => {
  const index = new Map([["FMC_A_Door_Single_Flush", ["d.json"]], ["FMC_A_Window_Laboratory_Fixed", ["w.json"]]]);
  assert.equal(findRecipes(index, "single door")[0].family, "FMC_A_Door_Single_Flush");
  assert.deepEqual(findRecipes(index, "gable vent"), []);
  assert.deepEqual(suggestRecipe("louvred gable vent"), { name: "FMC_A_Louvred_GableVent", folder: "Recipes\\Families\\A" });
  const rel = relatedStandards(resolve(kit, null), "sliding door").map((r) => r.key);
  assert.ok(rel.includes("doors.internal") && rel.includes("accessibility.turning_circle"));
});
