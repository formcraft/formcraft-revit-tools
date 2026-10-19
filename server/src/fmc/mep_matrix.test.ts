import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MATRIX_STATES, loadMatrix, matrixGrid, summarize, validateMatrix } from "./mep_matrix.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FILE = path.join(ROOT, "docs", "tracker", "mep_matrix.json");
const raw = () => JSON.parse(fs.readFileSync(FILE, "utf8"));

test("the repo's matrix is sound: 23 systems, 7 capabilities, 161 cells, every evidence path in the repo", () => {
  const { matrix, errors } = validateMatrix(raw(), ROOT);
  assert.deepEqual(errors, []);
  assert.equal(matrix!.systems.length, 23);
  assert.equal(matrix!.capabilities.length, 7);
  assert.equal(matrix!.cells.length, 161);
});

test("systems and capabilities in the agreed order", () => {
  const m = raw();
  assert.deepEqual(m.systems.map((s: any) => s.name), ["Power distribution", "Lighting", "Small power", "ELV & security", "Fire alarm", "Fire fighting",
    "Sprinklers", "Cold water", "Hot water", "Drainage", "Rainwater", "Gas", "High pressure", "Ventilation", "Air conditioning", "Refrigerant", "BMS",
    "Lightning", "Earthing", "Solar", "Generators", "Lifts", "Structural"]);
  assert.deepEqual(m.capabilities.map((c: any) => c.name), ["Enrich", "Size", "Diagram", "Calculate", "Review", "Quantities", "Document"]);
  assert.deepEqual(m.states, [...MATRIX_STATES]);
});

test("honest today: nothing is tested in Revit yet, line diagrams are built, the kit's calcs wait for E1", () => {
  const m = validateMatrix(raw()).matrix!;
  const s = summarize(m);
  assert.equal(s.tested, 0);
  assert.equal(s.cells, 161);
  assert.equal(Object.values(s.by_state).reduce((a, b) => a + b, 0), 161);
  const cell = (sys: string, cap: string) => m.cells.find((c) => c.system === sys && c.capability === cap)!;
  assert.equal(cell("power_distribution", "diagram").state, "Built, Revit check due");
  assert.equal(cell("power_distribution", "diagram").feature, "F23");
  assert.equal(cell("drainage", "calculate").state, "Kit calculation only");
  assert.equal(cell("drainage", "calculate").step, "E1");
  assert.equal(cell("power_distribution", "enrich").step, "E3");
  assert.match(cell("power_distribution", "enrich").note, /Electrical 0\.1/);
  assert.equal(cell("structural", "diagram").state, "Not applicable");
  assert.equal(s.per_system.find((x) => x.id === "structural")!.applicable, 5);
  assert.match(s.headline, /^0 of 159 cells tested in Revit/);
});

test("the grid has one row per system with a state per capability", () => {
  const g = matrixGrid(validateMatrix(raw()).matrix!);
  assert.equal(g.rows.length, 23);
  assert.ok(g.rows.every((r) => r.states.length === 7 && r.states.every((s) => (MATRIX_STATES as readonly string[]).includes(s))));
  assert.equal(g.rows[0].system, "Power distribution");
});

test("a broken matrix is refused in plain words", () => {
  const m = raw();
  m.cells[0].state = "Done";
  assert.ok(validateMatrix(m).errors.some((e) => e.includes("state")));

  const n = raw();
  n.cells.pop();
  n.cells[1].evidence = ["server/src/does_not_exist.ts"];
  n.cells[2] = { ...n.cells[2], state: "Planned", evidence: ["server/src/fmc/systems.ts"] };
  const errors = validateMatrix(n, ROOT).errors;
  assert.ok(errors.some((e) => e.includes("160 cells, expected 161")));
  assert.ok(errors.some((e) => e.includes("does_not_exist.ts is not in the repo")));
  assert.ok(errors.some((e) => e.includes("only built cells do")));

  const o = raw();
  o.systems.pop();
  assert.ok(validateMatrix(o).errors.some((e) => e.includes("22 systems")));
});

test("loads from the argument or FMC_MEP_MATRIX, and falls back to the repo's copy beside the build", () => {
  assert.ok(loadMatrix(FILE).matrix);
  assert.ok(loadMatrix("", { FMC_MEP_MATRIX: FILE }).matrix);
  const fallback = loadMatrix(path.join(ROOT, "nope.json"), { FMC_MEP_MATRIX: path.join(ROOT, "nope2.json") });
  assert.equal(path.resolve(fallback.file), path.resolve(FILE));
  assert.ok(fallback.matrix);
});
