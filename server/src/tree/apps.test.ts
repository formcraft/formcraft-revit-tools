import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCis } from "../fmc/brief.js";
import { treeFromBrief } from "./building.js";
import { quantityCsv, treeSearchSets } from "./apps.js";
import { ICU_BAY_SAMPLE } from "./samples.js";

const cis = parseCis(JSON.stringify({
  schema: "fmc-cis/0.1", project: "F26001", levels: [{ name: "00 Ground Floor", elevation_mm: 0 }, { name: "01 First Floor", elevation_mm: 4200 }],
  rooms: [
    { number: "G01", name: "Reception", params: { FMC_Target_Area: 18, FMC_Department: "Outpatients" } },
    { number: "G02", name: "Consult 1", params: { FMC_Target_Area: 12, FMC_Department: "Outpatients" } },
  ],
})).cis!;
const built = () => treeFromBrief(cis, { wall_type: "W", wall_thickness: 200, ceiling_type: "C", ceiling_height: 2700, corridor_width: 1800,
  level_prefixes: { G: "00 Ground Floor" } }).tree;

test("T6: Navisworks search sets per room, department and level, found by the tree's mark in Revit Comments", () => {
  const sets = treeSearchSets(built());
  assert.deepEqual(sets.map((s) => [s.path.join(" › "), s.name, s.contains]), [
    ["00 Ground Floor", "All of 00 Ground Floor", "FMC:L-00-Ground-Floor."],
    ["00 Ground Floor › Outpatients", "All of Outpatients", "FMC:L-00-Ground-Floor.Outpatients."],
    ["00 Ground Floor › Outpatients", "Outpatients corridor", "FMC:L-00-Ground-Floor.Outpatients.Corridor"],
    ["00 Ground Floor › Outpatients", "G01 Reception", "FMC:L-00-Ground-Floor.Outpatients.G01.Room"],
    ["00 Ground Floor › Outpatients", "G02 Consult 1", "FMC:L-00-Ground-Floor.Outpatients.G02.Room"],
  ]);
  assert.ok(!sets.some((s) => s.contains.includes("Library")), "templates have no elements");
});

test("T6: a hand-made tree whose ids don't nest gets room sets only (an 'All of' set would find nothing)", () => {
  const sets = treeSearchSets(ICU_BAY_SAMPLE);
  assert.deepEqual(sets.map((s) => s.name), ["L2-ICU-01 ICU bay"]);
});

test("T6: Power BI gets tidy CSV: one row per room, a summary per level and department, and the checks", () => {
  const [rooms, summary, checks] = quantityCsv(built());
  const lines = rooms.text.trim().split(/\r?\n/);
  assert.equal(lines[0], "node,level,department,number,name,area_m2,target_m2,off_pct,walls_m,doors,windows,items");
  assert.equal(lines.length, 1 + 3, "two rooms and the corridor");
  assert.ok(lines.some((l) => l.includes("G01,Reception,18.2,18,1.1,")), "5200 × 3500 (kept within 1.5 : 1) for 18 m²");
  assert.match(summary.text, /total,Building,3,/);
  assert.match(summary.text, /department,00 Ground Floor › Outpatients,3,/);
  assert.equal(checks.text.trim(), "kind,text", "nothing off target, no problems");
});
