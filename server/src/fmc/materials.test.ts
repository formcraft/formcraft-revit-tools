import { test } from "node:test";
import assert from "node:assert/strict";
import { auditMaterials, duplicateOf, parseMaterialDb, resolveMaterial, searchMaterials } from "./materials.js";

const db = parseMaterialDb({
  version: "1.3",
  materials: [
    { name: "FMC_Tile_Porcelain_600", class: "Finishes", sub: "floor", keynote: "F.TIL_02", cost_code: "M.20.04", supplier: "[SUPPLIER]",
      graphics: { shaded: "#D8D2C4", surface: "600x600 grid", cut: "none" },
      maps: [{ map: "Colour", file: "tile_porc_600_col.jpg", size_mm: 600 }] },
    { name: "FMC_Concrete_C25-30", class: "Concrete", keynote: "C.CON_01" },
    { name: "FMC_Concrete_C25-30", class: "Concrete" },
    { class: "Glass" },
  ],
});

test("the database reads tolerantly and reports its own problems", () => {
  assert.equal(db.version, "1.3");
  assert.equal(db.materials.length, 2);
  assert.deepEqual(db.classes, ["Concrete", "Finishes"]);
  assert.equal(db.problems.length, 2);
  assert.equal(db.materials[0].maps[0].size_mm, 600);
});

test("search by class and words", () => {
  assert.deepEqual(searchMaterials(db, "Finishes", "").map((m) => m.name), ["FMC_Tile_Porcelain_600"]);
  assert.deepEqual(searchMaterials(db, "All", "c.con").map((m) => m.name), ["FMC_Concrete_C25-30"]);
});

test("duplicates are Revit's (1) copies and its Default materials", () => {
  const names = new Set(["Concrete", "Concrete (1)"]);
  assert.equal(duplicateOf("Concrete (1)", names), "Concrete");
  assert.equal(duplicateOf("Default Wall", names), "Default");
  assert.equal(duplicateOf("FMC_Steel_S275", names), null);
});

test("the audit counts what's not in the database, duplicates, broken textures, unused and names", () => {
  const checks = auditMaterials([
    { id: 1, name: "FMC_Tile_Porcelain_600", used: true, textures: ["Z:\\tex\\ok.jpg"] },
    { id: 2, name: "Concrete", used: true, textures: [] },
    { id: 3, name: "Concrete (1)", used: false, textures: ["C:\\gone\\old.jpg"] },
  ], db, (p) => p.endsWith("ok.jpg"));
  assert.deepEqual(checks.map((c) => `${c.found} ${c.result}`), ["2 Warn", "1 Warn", "1 Fail", "1 Info", "2 Warn"]);
  assert.deepEqual(checks[2].ids, [3]);
});

test("a kit material resolves to absolute texture paths beside the database; a missing file is a warning, never a guess", () => {
  const kit = parseMaterialDb({ version: "2026-10-15", materials: [{
    name: "FMC_Concrete_C20", class: "Concrete", keynote: "C.STR_02", cost_code: "PKG-02-CONCRETE", description: "C20/25 in-situ concrete",
    graphics: { shaded: "#B8B6AE", cut: "FMC_Concrete_Reinforced" },
    maps: [{ map: "albedo", file: "Textures/FMC_Concrete_C20_albedo.jpg", size_mm: 1000, height_mm: 1000 },
      { map: "bump", file: "Textures/FMC_Concrete_C20_bump.jpg", size_mm: 1000 },
      { map: "roughness", file: "Textures/x.jpg" }] }] });
  const file = "Z:\\00_Standards\\07_Materials\\FMC_Materials.json";
  const on = new Set(["Z:\\00_Standards\\07_Materials\\Textures\\FMC_Concrete_C20_albedo.jpg"]);
  const { material, warnings } = resolveMaterial(kit.materials[0], file, (p) => on.has(p));
  assert.equal(material.shaded, "#B8B6AE");
  assert.equal(material.description, "C20/25 in-situ concrete");
  assert.deepEqual(material.maps.map((m) => [m.map, m.path, m.found, m.height_mm]), [
    ["albedo", "Z:\\00_Standards\\07_Materials\\Textures\\FMC_Concrete_C20_albedo.jpg", true, 1000],
    ["bump", "Z:\\00_Standards\\07_Materials\\Textures\\FMC_Concrete_C20_bump.jpg", false, 1000],
  ]);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join(" | "), /roughness map isn't applied/);
  assert.match(warnings.join(" | "), /isn't on disk, so the material is made without its bump map/);
});

test("without the database the audit says so instead of flagging everything", () => {
  assert.equal(auditMaterials([{ id: 1, name: "X", used: true, textures: [] }], null, () => true)[0].result, "Info");
});
