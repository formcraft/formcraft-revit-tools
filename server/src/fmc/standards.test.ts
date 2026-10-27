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

test("Standards sources (owner 27 Oct): each code's revision, keys and open gaps; filtered by id, title or key", async () => {
  const { sourcesView } = await import("./standards.js");
  const reg = { sources: [
    { id: "UG-NBC-2019", title: "The National Building Code, 2019", keys: ["stairs.headroom", "rooms.kitchen_min"],
      gaps: [{ id: "NBC-1", what: "stair width digit lost", where: "para 41", kind: "lost_digit", status: "open" }, { id: "NBC-0", what: "x", where: "y", kind: "table", status: "filled" }] },
    { id: "UG-ACC-2019", title: "Accessibility Code", keys: ["accessibility.ramp"], gaps: [{ id: "ACC-1", what: "figures", where: "Schedule", kind: "figure", status: "open" }] },
  ] };
  const all = sourcesView(reg);
  assert.equal(all.count, 2); assert.equal(all.open_gaps, 2); assert.deepEqual(all.by_kind, { lost_digit: 1, figure: 1 });
  const one = sourcesView(reg, "kitchen");
  assert.equal(one.count, 1); assert.equal(one.sources[0].id, "UG-NBC-2019"); assert.deepEqual(one.sources[0].gaps.map((g) => g.id), ["NBC-1"]);
});
