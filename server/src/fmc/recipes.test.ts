import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateA, parseRecipe, releasePath, roleOf, stagingPath, typeValues } from "./recipes.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const heater = fs.readFileSync(path.join(REPO, "tests", "doc", "FMC_P_MechEq_WaterHeater_Instant.ops.json"), "utf8");

const door = (o: object = {}) => JSON.stringify({
  schema: "fmc-recipe/0.1", family: "FMC_A_Door_SteelFanlight", template: "Metric Door.rft",
  ops: [
    { op: "set_category", name: "OST_Doors" },
    { op: "add_family_param", name: "Width", type: "Length" },
    { op: "add_type", name: "900x2100" }, { op: "add_type", name: "800x2100" },
    { op: "set_type_value", name: "900x2100/Width", type: "900x2100", param: "Width", value: 900 },
    { op: "set_type_value", name: "800x2100/Width", type: "800x2100", param: "Width", value: 800 },
  ],
  values: { "Steel gauge": { value: "18", source_status: "verified", source: "Roofings datasheet" }, "Fanlight height": { value: 450, source_status: "assumed" } },
  checks: { clear_opening_min_mm: 900 },
  ...o,
});
const passInspect = { category: "Doors", checks: [{ check: "Name follows the kit", state: "pass", detail: "ok" }] };
const passFlex = { ok: true, types: [{ type: "900x2100", ok: true }] };

test("the B1 water-heater batch is a recipe as it stands", () => {
  const r = parseRecipe(heater);
  assert.deepEqual(r.problems, []);
  assert.equal(r.recipe!.ops.length, 39);
  assert.equal(r.recipe!.schema, "fmc-recipe/0.1");
});

test("a recipe that can't be read is refused with the reason", () => {
  assert.match(parseRecipe("{").problems[0], /Not JSON/);
  assert.match(parseRecipe(door({ schema: "x" })).problems[0], /schema must be/);
  assert.match(parseRecipe(door({ ops: [] })).problems[0], /ops/);
});

test("staging and release paths follow the role in the name", () => {
  assert.equal(roleOf("FMC_A_Door_SteelFanlight"), "A");
  assert.equal(stagingPath("K:\\04_Families\\_Staging", "FMC_FP_MechEq_Pump"), "K:\\04_Families\\_Staging\\FP\\FMC_FP_MechEq_Pump.rfa");
  assert.equal(releasePath("K:\\04_Families\\_Staging\\", "FMC_A_Door_X"), "K:\\04_Families\\A\\FMC_A_Door_X.rfa");
  assert.equal(typeValues(parseRecipe(door()).recipe!).get("800x2100")!.get("Width"), 800);
});

test("Gate A: a type narrower than the code's clear opening fails; assumed values warn; pending blocks release", () => {
  const g = gateA("FMC_A_Door_SteelFanlight", parseRecipe(door()).recipe, { inspect: passInspect, flex: passFlex, registerCategory: "Doors" });
  const by = Object.fromEntries(g.lines.map((l) => [l.check, l]));
  assert.equal(g.verdict, "Fail");
  assert.equal(by["Clear opening at least 900 mm"].state, "Fail");
  assert.match(by["Clear opening at least 900 mm"].detail, /800x2100 800 mm/);
  assert.equal(by["Values from a verified source"].state, "Warn");
  assert.equal(by["IFC class set"].state, "Warn");
  assert.equal(by["Tag, schedule and legend; Coarse, Medium and Fine"].state, "Not checked");

  const pending = gateA("FMC_A_Door_SteelFanlight", parseRecipe(door({ values: { Leaf: { value: 1, source_status: "pending" } }, checks: {} })).recipe,
    { inspect: passInspect, flex: passFlex, registerCategory: "Doors" });
  assert.equal(pending.verdict, "Fail");
  assert.match(pending.lines.find((l) => l.check === "Values from a verified source")!.detail, /Pending, so not releasable: Leaf/);
});

test("Gate A: flex failures and a wrong category fail; checks that need a project are never shown as passed", () => {
  const g = gateA("FMC_A_Door_SteelFanlight", null, { inspect: { ...passInspect, category: "Windows" },
    flex: { ok: false, types: [{ type: "900x2100", ok: false, errors: ["Can't keep Width"] }] }, registerCategory: "Doors" });
  const by = Object.fromEntries(g.lines.map((l) => [l.check, l]));
  assert.equal(by["Every type flexes"].state, "Fail");
  assert.match(by["Every type flexes"].detail, /Can't keep Width/);
  assert.equal(by["Category against the register"].state, "Fail");
  assert.equal(by["Code checks and value sources"].state, "Not checked");
  assert.ok(!g.lines.some((l) => l.state === "Pass" && /schedule/.test(l.check)));
});

test("release is the pane's: it needs a reviewer, a note and a passed gate, never overwrites, and logs every decision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-release-"));
  const staging = path.join(dir, "04_Families", "_Staging");
  fs.mkdirSync(path.join(staging, "A"), { recursive: true });
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({ family_staging_root: staging, write_roots: [staging], reports_dir: path.join(dir, "reports") }));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  try {
    const { paneRelease } = await import("../tools/fmc_recipe.js");
    const file = path.join(staging, "A", "FMC_A_Door_X.rfa");
    fs.writeFileSync(file, "rfa");
    assert.match(paneRelease("family_release", { file }, "j.okello").error!, /reviewer and a note/);
    assert.match(paneRelease("family_release", { file, reviewer: "Lead A", note: "ok" }, "j.okello").error!, /Run Gate A first/);
    fs.writeFileSync(file.replace(/\.rfa$/, ".gate.json"), JSON.stringify({ verdict: "Fail" }));
    assert.match(paneRelease("family_release", { file, reviewer: "Lead A", note: "ok" }, "j.okello").error!, /didn't pass/);
    assert.equal(paneRelease("family_sendback", { file, reviewer: "Lead A", note: "Flex fails on 800" }, "j.okello").sent_back, "FMC_A_Door_X");
    fs.writeFileSync(file.replace(/\.rfa$/, ".gate.json"), JSON.stringify({ verdict: "Pass" }));
    const r = paneRelease("family_release", { file, reviewer: "Lead A", note: "Checked against the datasheet" }, "j.okello");
    assert.equal(r.to, path.join(dir, "04_Families", "A", "FMC_A_Door_X.rfa"));
    assert.ok(fs.existsSync(r.to!) && !fs.existsSync(file));
    const log = fs.readFileSync(path.join(dir, "04_Families", "FMC_Release_Log.csv"), "utf8");
    assert.match(log, /sent back.*Lead A.*j\.okello.*Flex fails on 800/);
    assert.match(log, /released.*Lead A.*j\.okello/);
    fs.writeFileSync(file, "again");
    fs.writeFileSync(file.replace(/\.rfa$/, ".gate.json"), JSON.stringify({ verdict: "Pass" }));
    assert.match(paneRelease("family_release", { file, reviewer: "Lead A", note: "v2" }, "j.okello").error!, /exists: the Family Librarian archives/);
  } finally {
    if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old;
  }
});

test("the reference LOD 400 door recipe parses and its ops pass the batch checks", async () => {
  const { OPS, opsProblems, splitProblems } = await import("./ops.js");
  const raw = fs.readFileSync(path.join(REPO, "tests", "recipes", "FMC_A_Door_FlushSingleLeaf.recipe.json"), "utf8");
  const { recipe, problems } = parseRecipe(raw);
  assert.deepEqual(problems, []);
  OPS.parse(recipe!.ops);
  const { errors } = splitProblems(opsProblems(recipe!.ops, null));
  // With no dictionary, only the shared parameters are flagged; every other op is well formed.
  assert.ok(errors.every((e) => /shared parameter file isn't readable/.test(e)), errors.join(" | "));
  assert.ok(Object.values(recipe!.values).some((v) => v.source_status === "pending"));
});
