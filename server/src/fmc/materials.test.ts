import { test } from "node:test";
import assert from "node:assert/strict";
import { auditMaterials, duplicateOf, parseMaterialDb, searchMaterials } from "./materials.js";

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

test("without the database the audit says so instead of flagging everything", () => {
  assert.equal(auditMaterials([{ id: 1, name: "X", used: true, textures: [] }], null, () => true)[0].result, "Info");
});
