import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORY_CHECK, SIDES_CHECK, categoryLine, gateA, lodLadder, lodLine, nameToken, parseRecipe, recordSides, releasePath, roleOf, stagingPath, typeValues } from "./recipes.js";
import { checkFamily, familyKind, nameCheck } from "./library.js";

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
/** Part of the kit's Family_Name_Tokens (FMC_Revit_Kit.xlsx): token → Revit category. */
const TOKENS = new Map([["Door", "Doors"], ["Window", "Windows"], ["GenericModel", "Generic Models"], ["Profile", "Profiles"], ["DetailItem", "Detail Items"]]);
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
    flex: { ok: false, types: [{ type: "900x2100", ok: false, errors: ["Can't keep Width"] }] }, registerCategory: "Doors", tokenCategories: TOKENS });
  const by = Object.fromEntries(g.lines.map((l) => [l.check, l]));
  assert.equal(by["Every type flexes"].state, "Fail");
  assert.match(by["Every type flexes"].detail, /Can't keep Width/);
  assert.equal(by[CATEGORY_CHECK].state, "Fail");
  assert.match(by[CATEGORY_CHECK].detail, /Windows; the register says Doors; the name's token Door means Doors/);
  assert.equal(by["Code checks and value sources"].state, "Not checked");
  assert.ok(!g.lines.some((l) => l.state === "Pass" && /schedule/.test(l.check)));
});

test("F-047: the category is checked against the register, the spec and the name's token; any mismatch fails", () => {
  // The kit files FloorFall under Generic Annotations, but its name says GenericModel
  const floorFall = categoryLine("FMC_A_GenericModel_FloorFall", "Generic Annotations",
    { registerCategory: "Generic Annotations", specCategory: "Generic Annotations", tokenCategories: TOKENS });
  assert.equal(floorFall.state, "Fail");
  assert.match(floorFall.detail, /the name's token GenericModel means Generic Models, but the register files it under Generic Annotations/);
  const g = gateA("FMC_A_GenericModel_FloorFall", null, { inspect: { ...passInspect, category: "Generic Annotations" }, flex: passFlex,
    registerCategory: "Generic Annotations", specCategory: "Generic Annotations", tokenCategories: TOKENS });
  assert.equal(g.verdict, "Fail");

  assert.equal(categoryLine("FMC_A_Door_X", "Doors", { registerCategory: "Doors", specCategory: "Doors", tokenCategories: TOKENS }).state, "Pass");
  // the spec disagreeing with the family is a fail too
  const spec = categoryLine("FMC_A_GenericModel_X", "Generic Models", { registerCategory: "Generic Models", specCategory: "Generic Annotations", tokenCategories: TOKENS });
  assert.equal(spec.state, "Fail");
  assert.match(spec.detail, /the spec says Generic Annotations/);
  // a register that records the exception in its category text warns; alternatives and notes in brackets are read
  assert.equal(categoryLine("FMC_S_GenericModel_BasePlate", "Structural Connections",
    { registerCategory: "Structural Connections (no kit token; GenericModel until StrConnection is added)", tokenCategories: TOKENS }).state, "Warn");
  assert.equal(categoryLine("FMC_A_GenericModel_Plinth", "Generic Models", { registerCategory: "Walls (system) / Generic Models", tokenCategories: TOKENS }).state, "Pass");
  assert.equal(categoryLine("FMC_TB_KeyPlan", "Generic Annotations", { registerCategory: "Generic Annotations (nested in title block)", tokenCategories: TOKENS }).state, "Pass");
  assert.equal(categoryLine("FMC_Profile_Cornice", "Profiles", { registerCategory: "Profiles", tokenCategories: TOKENS }).state, "Pass");
  assert.equal(categoryLine("FMC_Profile_Cornice", "Generic Models", { registerCategory: null, tokenCategories: TOKENS }).state, "Fail");
  // the token table unreadable: said, never passed silently
  assert.match(categoryLine("FMC_A_Door_X", "Doors", { registerCategory: "Doors", tokenCategories: null }).detail, /Family_Name_Tokens table wasn't readable/);
  assert.equal(categoryLine("Vendor_Thing", "Doors", { registerCategory: null, tokenCategories: TOKENS }).state, "Not checked");
  assert.equal(categoryLine("FMC_A_Door_X", "", { registerCategory: "Doors", tokenCategories: TOKENS }).state, "Not checked");
  assert.equal(nameToken("FMC_A_Door_X"), "Door");
  assert.equal(nameToken("F26001_E_ElecFixture_Isolator"), "ElecFixture");
  assert.equal(nameToken("FMC_TB_Panel_ProjectData"), null);
  assert.equal(nameToken("FMC_DI_A_DoorHead"), null);
});

const SPECS = new Map([
  ["FMC_Profile_Cornice", { family: "FMC_Profile_Cornice", category: "Profiles", shared_parameters: [{ name: "FMC_Theme", binding: "Type", guid: null }] }],
  ["FMC_TB_Panel_ProjectData", { family: "FMC_TB_Panel_ProjectData", category: "Title Blocks", shared_parameters: [{ name: "FMC_Theme", binding: "Type", guid: null }] }],
  ["FMC_DI_A_DoorHead", { family: "FMC_DI_A_DoorHead", category: "Detail Items", shared_parameters: [{ name: "FMC_Theme", binding: "Type", guid: null }] }],
]) as any;
const KIT = new Map([["FMC_Theme", { name: "FMC_Theme", guid: "11111111-2222-3333-4444-555555555555" }]]) as any;
const GUIDS = ["11111111-2222-3333-4444-555555555555"];

test("F-045: profiles, title blocks and annotations use their own naming; keynotes and type names by kind", () => {
  assert.equal(familyKind("Profiles"), "profile");
  assert.equal(familyKind("Title Blocks"), "title block");
  assert.equal(familyKind("Generic Annotations"), "annotation");
  assert.equal(familyKind("Door Tags"), "annotation");
  assert.equal(familyKind("Section Heads"), "annotation");
  assert.equal(familyKind("Generic Models"), "model");
  assert.equal(familyKind("Detail Items"), "model");
  assert.equal(familyKind("", "FMC_Profile_Cornice"), "profile");
  assert.equal(familyKind("", "FMC_TB_Panel_ProjectData"), "title block");

  // A profile: FMC_Profile_<Element>, keynoted (J.TRM / A.ORN codes), types named by movement
  const profile = checkFamily({ name: "FMC_Profile_Cornice", category: "Profiles", shared_guids: GUIDS,
    types: [{ name: "Greek", keynote: "A.ORN_00" }, { name: "Federal / Adam", keynote: "A.ORN_00" }] }, SPECS, KIT);
  const p = Object.fromEntries(profile.checks.map((c) => [c.check, c]));
  assert.equal(p["Name follows FMC_[Role]_[Category]_[Description]"].state, "pass");
  assert.equal(p["Keynote set"].state, "pass");
  assert.equal(p["Type names [KeySize]_[Variant]"].state, "na");
  assert.equal(p["Type names [KeySize]_[Variant]"].applies, false);
  assert.equal(profile.state, "Compliant");
  const bare = checkFamily({ name: "FMC_Profile_StringCourse", category: "Profiles", shared_guids: [], types: [{ name: "Greek", keynote: "" }] }, SPECS, KIT);
  assert.equal(bare.checks.find((c) => c.check === "Keynote set")!.state, "fail", "a profile needs its keynote");
  assert.equal(bare.checks[0].state, "pass", "FMC_Profile_<Element> is the kit's naming even when the register doesn't list it");
  assert.equal(checkFamily({ name: "FMC_Profile_Cornice_J.TRM", category: "Profiles", shared_guids: [], types: [] }, new Map(), KIT).checks[0].state, "fail");

  // A title block: FMC_TB_*, no keynote, types by sheet size
  const tb = checkFamily({ name: "FMC_TB_Panel_ProjectData", category: "Title Blocks", shared_guids: GUIDS, types: [{ name: "Standard", keynote: "" }] }, SPECS, KIT);
  const t = Object.fromEntries(tb.checks.map((c) => [c.check, c]));
  assert.equal(t["Name follows FMC_[Role]_[Category]_[Description]"].state, "pass");
  assert.equal(t["Keynote set"].state, "na");
  assert.match(t["Keynote set"].detail, /Not applied to title blocks/);
  assert.equal(t["Type names [KeySize]_[Variant]"].state, "na");
  assert.equal(tb.state, "Compliant");
  assert.equal(checkFamily({ name: "FMC_TitleBlock", category: "Title Blocks", shared_guids: [], types: [{ name: "A1", keynote: "" }] }, new Map(), KIT).checks[0].state, "pass");
  assert.equal(checkFamily({ name: "A1 metric", category: "Title Blocks", shared_guids: [], types: [] }, new Map(), KIT).checks[0].state, "fail");

  // An annotation symbol and a kit name outside the model pattern (FMC_DI_*: listed in the register)
  assert.equal(nameCheck("FMC_SYM_A_FloorFall", "annotation").ok, true);
  assert.equal(nameCheck("FMC_DI_A_DoorHead", "model", SPECS).ok, true);
  assert.equal(nameCheck("FMC_DI_A_DoorHead", "model").ok, false);
  // A model family still follows FMC_[Role]_[Token]_[Description] and [KeySize]_[Variant]
  const door = checkFamily({ name: "FMC_A_Door_X", category: "Doors", shared_guids: [], types: [{ name: "Standard", keynote: "D.MET_01" }] }, new Map(), KIT);
  assert.equal(door.checks.find((c) => c.check === "Type names [KeySize]_[Variant]")!.state, "fail");
});

test("F-045: 'Required FMC parameters' never passes on nothing, whatever the library's line says", () => {
  const req = "Required FMC parameters present (by GUID)";
  const line = (detail: string, state = "pass") => gateA("FMC_A_Door_X", null, { inspect: { ...passInspect, checks: [{ check: req, state, detail }] }, flex: passFlex, registerCategory: "Doors" })
    .lines.find((l) => l.check === req)!;
  assert.equal(line("0 present").state, "Fail");
  assert.equal(line("present").state, "Fail");
  assert.equal(line("0 of 0 present by GUID").state, "Fail");
  assert.equal(line("3 present").state, "Pass");
  assert.equal(line("20 present").state, "Pass");
  // no such line at all: said, not skipped
  assert.equal(gateA("FMC_A_Door_X", null, { inspect: passInspect, flex: passFlex, registerCategory: "Doors" }).lines.find((l) => l.check === req)!.state, "Not checked");
});

test("F-045: the dimension-sides line is on every gate: from this flex, else the build's record, else Not checked with why", () => {
  const recorded = recordSides({ ok: true, dimension_sides: { checked: 4, unrecorded: 0 }, types: [{ type: "900x2100", ok: true }] }, "2026-10-15T10:00:00Z")!;
  assert.deepEqual(recorded.dimension_sides, { checked: 4, unrecorded: 0 });
  assert.equal(recordSides({ ok: true, types: [] }, "t"), null, "an add-in that doesn't report sides records nothing");

  // the gate couldn't open the file (F-024: open in Revit's window): the build's record answers
  const fromRecord = gateA("FMC_A_Door_X", null, { inspect: passInspect, flex: null, flexError: "the file is open in a Revit window", registerCategory: "Doors", recordedSides: recorded });
  const s = fromRecord.lines.find((l) => l.check === SIDES_CHECK)!;
  assert.equal(s.state, "Pass");
  assert.match(s.detail, /4 labelled dimensions keep their sides .*from the build's flex, 2026-10-15T10:00:00Z.*open in a Revit window/);

  // a flex that answered with an error is "didn't run", not a failing type; the record still answers
  const errored = gateA("FMC_A_Door_X", null, { inspect: passInspect, flex: { ok: false, error: "No open session 's1'" }, registerCategory: "Doors", recordedSides: recorded });
  assert.equal(errored.lines.find((l) => l.check === "Every type flexes")!.state, "Not checked");
  assert.match(errored.lines.find((l) => l.check === "Every type flexes")!.detail, /No open session/);
  assert.equal(errored.lines.find((l) => l.check === SIDES_CHECK)!.state, "Pass");

  // a flipped plane in the record still fails
  const flipped = { ...recorded, wrong: [{ type: "900x2400", a: "Head Inner", b: "Head", label: "Frame Width", axis: "z", drawn: 1, now_mm: -40 }] };
  assert.equal(gateA("FMC_A_Door_X", null, { inspect: passInspect, flex: null, registerCategory: "Doors", recordedSides: flipped }).verdict, "Fail");

  // nothing to go on: the line is there, Not checked, with the reason
  const none = gateA("FMC_A_Door_X", null, { inspect: passInspect, flex: null, flexError: "file in use", registerCategory: "Doors" }).lines.find((l) => l.check === SIDES_CHECK)!;
  assert.equal(none.state, "Not checked");
  assert.match(none.detail, /Flex didn't run: file in use, and no build record holds the sides/);
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

test("a kit profile recipe parses and its closed profile_lines loop passes the batch checks", async () => {
  const { OPS, opsProblems, splitProblems } = await import("./ops.js");
  const raw = fs.readFileSync(path.join(REPO, "tests", "recipes", "_profiles", "FMC_Profile_Architrave_Contemporary.recipe.json"), "utf8");
  const { recipe, problems } = parseRecipe(raw);
  assert.deepEqual(problems, []);
  assert.equal(recipe!.template, "Metric Profile.rft");
  OPS.parse(recipe!.ops);
  const { errors, notes } = splitProblems(opsProblems(recipe!.ops, null));
  assert.ok(errors.every((e) => /shared parameter file isn't readable/.test(e)), errors.join(" | "));
  assert.deepEqual(notes, []);
  assert.ok(recipe!.ops.some((o) => o.op === "set_type_value" && o.param === "Keynote" && /^J\.TRM_\d\d$/.test(String(o.value))));
});

// ---------------------------------------------------------------- F-029, F-038, F-039, F-040

const recipeFile = (name: string) => parseRecipe(fs.readFileSync(path.join(REPO, "tests", "recipes", name), "utf8")).recipe!;

test("F-029: the LOD 400 recipes are too big for one call to Revit; stepwise chunks all fit the bridge", async () => {
  const { BRIDGE_LIMIT_BYTES, applyEnvelope, planChunks, requestBytes } = await import("./recipebuild.js");
  const envelope = requestBytes("fmc_doc_apply", applyEnvelope("abcd1234", "Z:\\00_Standards\\01_Shared_Parameters\\FMC_SharedParameters.txt"));
  const steel = recipeFile("FMC_A_Door_SteelFanlight.recipe.json");
  assert.ok(envelope + Buffer.byteLength(JSON.stringify(steel.ops)) > BRIDGE_LIMIT_BYTES, "the whole batch is over the 8 KB read");
  // The doors and windows carry 20 profile sweeps per trimmed face, so even the reference door needs chunks now; a
  // profile family (a copy of one of the kit's 320 profile recipes) still fits one call.
  const door = recipeFile("FMC_A_Door_FlushSingleLeaf.recipe.json");
  const small = recipeFile("_profiles/FMC_Profile_Architrave_Contemporary.recipe.json");
  assert.ok(envelope + Buffer.byteLength(JSON.stringify(small.ops)) < BRIDGE_LIMIT_BYTES, "a profile recipe still fits one call");
  for (const r of [steel, door, small]) {
    const { chunks, tooBig } = planChunks(r.ops, 20, 6000, envelope);
    assert.deepEqual(tooBig, []);
    assert.equal(chunks[0].from, 1);
    assert.equal(chunks[chunks.length - 1].to, r.ops.length);
    chunks.forEach((c, i) => {
      if (i) assert.equal(c.from, chunks[i - 1].to + 1, "no op skipped or sent twice");
      assert.ok(c.to - c.from + 1 <= 20);
      assert.ok(requestBytes("fmc_doc_apply", { ...applyEnvelope("abcd1234", "Z:\\x.txt"), ops: r.ops.slice(c.from - 1, c.to) }) <= BRIDGE_LIMIT_BYTES);
    });
  }
});

test("F-029: where an apply stopped, renumbered to the whole recipe", async () => {
  const { renumberOpError, stoppedAt } = await import("./recipebuild.js");
  assert.deepEqual(renumberOpError("fmc_doc_apply: op 3 failed, nothing was changed: No reference plane X", 40),
    { op: 43, text: "fmc_doc_apply: op 43 failed, nothing was changed: No reference plane X" });
  const sent = "2026-10-15T09:13:00.000Z";
  assert.match(stoppedAt(null, 40, sent).text, /never started the batch/);
  assert.match(stoppedAt({ state: "running", started: "2026-10-15T09:12:00.000Z", op: 2 }, 40, sent).text, /never started/, "older progress belongs to another call");
  assert.match(stoppedAt({ state: "running", started: "2026-10-15T09:13:01.000Z", op: 0 }, 40, sent).text, /stopped before op 41/);
  const hung = stoppedAt({ state: "running", started: "2026-10-15T09:13:01.000Z", op: 5, kind: "sweep", name: "Frame", done: 4 }, 40, sent);
  assert.equal(hung.op, 45);
  assert.match(hung.text, /started op 45 \(sweep Frame\) and hadn't finished it; 4 ops before it were done/);
});

test("F-038: a door recipe's template planes (Left, Right) aren't 'not made earlier'; planes read from the template take over", async () => {
  const { dropTemplateNotes, rememberTemplatePlanes, templatePlanes } = await import("./recipebuild.js");
  const { opsProblems, splitProblems } = await import("./ops.js");
  const r = recipeFile("FMC_A_Door_SteelFanlight.recipe.json");
  const { notes } = splitProblems(opsProblems(r.ops, null));
  const planeNotes = notes.filter((n) => /reference plane "(Left|Right)"/.test(n));
  assert.ok(planeNotes.length > 0, "the batch check alone flags the template's planes");
  const door = templatePlanes("C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates\\English\\Metric Door.rft");
  for (const p of ["Left", "Right", "Exterior", "Interior", "Center (Left/Right)", "Head", "Ref. Level"]) assert.ok(door.planes.includes(p), p);
  const kept = dropTemplateNotes(notes, door.planes);
  assert.equal(kept.notes.filter((n) => /reference plane "(Left|Right)"/.test(n)).length, 0);
  assert.equal(kept.dropped, planeNotes.length);
  assert.ok(templatePlanes("Metric Window.rft").planes.includes("Sill"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-planes-"));
  rememberTemplatePlanes(dir, "X:\\T\\Metric Door.rft", ["Left", "Right", "Exterior", "Interior", "Jamb"]);
  const read = templatePlanes("Metric Door.rft", dir);
  assert.ok(read.planes.includes("Jamb") && read.planes.includes("Ref. Level"));
  assert.match(read.source, /read from Metric Door\.rft/);
});

test("F-039: Gate A checks the recipe's parameters by GUID, never passes on 0, gives inspect's reason, hints the host wall, checks dimension sides", () => {
  const guid = "aaaaaaaa-0000-0000-0000-000000000001";
  const withParam = door({ ops: [...JSON.parse(door()).ops, { op: "add_shared_param", name: "FMC_Asset_Tag", guid }], checks: {} });
  const r = parseRecipe(withParam).recipe!;
  const zero = { check: "Required FMC parameters present (by GUID)", state: "fail", detail: "0 required: the kit spec for X names no shared parameters, a kit change request" };
  const present = gateA("FMC_A_Door_SteelFanlight", r, { inspect: { ...passInspect, checks: [zero], shared_parameters: [{ name: "FMC_Asset_Tag", guid: guid.toUpperCase() }] }, flex: passFlex, registerCategory: "Doors" });
  const p = present.lines.find((l) => l.check === zero.check)!;
  assert.equal(p.state, "Pass");
  assert.match(p.detail, /1 of 1 present by GUID: FMC_Asset_Tag/);
  const missing = gateA("FMC_A_Door_SteelFanlight", r, { inspect: { ...passInspect, checks: [zero], shared_parameters: [] }, flex: passFlex, registerCategory: "Doors" });
  assert.equal(missing.lines.find((l) => l.check === zero.check)!.state, "Fail");
  assert.match(missing.lines.find((l) => l.check === zero.check)!.detail, new RegExp(`missing FMC_Asset_Tag \\(${guid}\\)`));
  const oldPass = gateA("FMC_A_Door_SteelFanlight", null, { inspect: { ...passInspect, checks: [{ ...zero, state: "pass", detail: "0 present" }] }, flex: passFlex, registerCategory: "Doors" });
  assert.equal(oldPass.lines.find((l) => l.check === zero.check)!.state, "Fail", "never Pass on 0");

  const noInspect = gateA("FMC_A_Door_SteelFanlight", null, { inspect: null, inspectError: "fmc_family_inspect: The file is in use", flex: passFlex, registerCategory: null });
  assert.match(noInspect.lines.find((l) => l.check === "Library checks on the saved file")!.detail, /couldn't be inspected: fmc_family_inspect: The file is in use/);

  const cut = gateA("FMC_A_Door_SteelFanlight", null, { inspect: passInspect, registerCategory: "Doors",
    flex: { ok: false, types: [{ type: "1800x6000", ok: false, errors: ["Can't make cut-out."] }] } });
  assert.match(cut.lines.find((l) => l.check === "Every type flexes")!.detail, /raise the host wall/);

  const sides = { checked: 3, unrecorded: 0 };
  const flipped = gateA("FMC_A_Door_SteelFanlight", null, { inspect: passInspect, registerCategory: "Doors", flex: { ok: true, dimension_sides: sides,
    types: [{ type: "900x2400", ok: true, dimension_sides: [{ a: "Head Inner", b: "Head", label: "Frame Width", axis: "z", drawn: 1, now_mm: -40 }] }] } });
  const line = flipped.lines.find((l) => l.check === "Labelled dimensions keep their planes' sides")!;
  assert.equal(line.state, "Fail");
  assert.equal(flipped.verdict, "Fail");
  assert.match(line.detail, /900x2400: Head was drawn above Head Inner \(Frame Width\), now 40 mm below it/);
  const fine = gateA("FMC_A_Door_SteelFanlight", null, { inspect: passInspect, registerCategory: "Doors", flex: { ok: true, dimension_sides: sides, types: [{ type: "900x2400", ok: true }] } });
  assert.equal(fine.lines.find((l) => l.check === "Labelled dimensions keep their planes' sides")!.state, "Pass");
  assert.equal(gateA("X", null, { inspect: passInspect, registerCategory: "Doors", flex: passFlex }).lines.find((l) => /planes' sides/.test(l.check))!.state, "Not checked");
});

test("plant recipes (Planting forms): parse, pass the batch checks, chunk under the bridge, size first, one keynote per type", async () => {
  const { OPS, opsProblems, splitProblems } = await import("./ops.js");
  const { BRIDGE_LIMIT_BYTES, applyEnvelope, dropTemplateNotes, planChunks, requestBytes, templatePlanes } = await import("./recipebuild.js");
  const envelope = requestBytes("fmc_doc_apply", applyEnvelope("abcd1234", "Z:\\00_Standards\\01_Shared_Parameters\\FMC_SharedParameters.txt"));
  for (const file of ["FMC_L_Planting_Tree_Sphere.recipe.json", "FMC_L_Planting_Palm_Feather.recipe.json"]) {
    const r = recipeFile(file);
    assert.equal(r.template, "Metric Planting.rft");
    OPS.parse(r.ops);
    const { errors, notes } = splitProblems(opsProblems(r.ops, null));
    // With no dictionary, only the shared parameters are flagged; every other op is well formed.
    assert.ok(errors.every((e) => /shared parameter file isn't readable/.test(e)), `${file}: ${errors.filter((e) => !/shared parameter/.test(e)).join(" | ")}`);
    // The template's own planes (Center planes) aren't "not made earlier" once the table knows Metric Planting.rft.
    const kept = dropTemplateNotes(notes, templatePlanes(r.template).planes).notes;
    assert.deepEqual(kept.filter((n) => /reference plane/.test(n)), [], file);
    // #134 / F-029: too big for one call, but every stepwise chunk fits the 8 KB bridge read.
    assert.ok(envelope + Buffer.byteLength(JSON.stringify(r.ops)) > BRIDGE_LIMIT_BYTES);
    const { chunks, tooBig } = planChunks(r.ops, 20, 6000, envelope);
    assert.deepEqual(tooBig, []);
    assert.equal(chunks[chunks.length - 1].to, r.ops.length);
    for (const c of chunks) assert.ok(requestBytes("fmc_doc_apply", { ...applyEnvelope("abcd1234", "Z:\\x.txt"), ops: r.ops.slice(c.from - 1, c.to) }) <= BRIDGE_LIMIT_BYTES);
    // Size first (F-026): type 1 and its sizes come before the first reference plane.
    const ops = r.ops as Array<Record<string, any>>;
    const firstPlane = ops.findIndex((o) => o.op === "add_ref_plane");
    const t1 = ops.find((o) => o.op === "add_type")!.name;
    for (const p of ["Height", "Crown Diameter", "Crown Height", "Trunk Height", "Trunk Diameter"])
      assert.ok(ops.findIndex((o) => o.op === "set_type_value" && o.type === t1 && o.param === p) < firstPlane, `${file}: ${p} before the planes`);
    // Every species solid and plan line is switched by its Show <Species> (Species Index = k); Coarse is the parametric box.
    const shows = new Set(ops.filter((o) => o.op === "set_formula").map((o) => o.name));
    const species = ops.filter((o) => (o.op === "revolution" || o.op === "blend" || o.op === "symbolic_lines"));
    assert.ok(species.length > 0 && species.every((s) => ops.some((o) => o.op === "set_visible_param" && o.solid === s.name && shows.has(o.param))));
    const coarse = ops.find((o) => o.op === "set_visibility" && o.name === "Coarse Crown")!;
    assert.deepEqual([coarse.coarse, coarse.medium, coarse.fine, coarse.plan_rcp], [true, false, false, false]);
    // One keynote per type; sizes are assumed, foliage material pending (kit change request).
    const types = ops.filter((o) => o.op === "add_type").map((o) => o.name);
    const keys = typeValues(r);
    assert.ok(types.every((t) => /^\d+_[A-Za-z]+$/.test(t) && /^L\.[A-Z]{3}_\d\d$/.test(String(keys.get(t)!.get("Keynote")))), file);
    assert.equal(Object.entries(r.values).find(([k]) => /^Foliage material/.test(k))![1].source_status, "pending");
  }
});

/** A Revit that answers fmc_doc like the add-in: sessions, chunks under the bridge limit, an op that fails, a chunk that's slow. */
function fakeRevit(o: { failOp?: number; slowOp?: number; appData: string; clock: { t: number }; msPerOp?: number }) {
  const calls: Array<Record<string, any>> = [];
  const open = new Map<string, number>(); // session -> ops applied
  let n = 0;
  const progressFile = (s: string) => path.join(o.appData, "Formcraft", "Progress", `fmc_doc_${s}.json`);
  const doc = async (a: Record<string, any>): Promise<any> => {
    calls.push(a);
    switch (a.action) {
      case "open": { const s = `s${++n}`; open.set(s, 0); return { ok: true, session: s, document: { reference_planes: ["Left", "Right"] } }; }
      case "report": return open.has(a.session) ? { ok: true } : { ok: false, error: `fmc_doc_report: No open session '${a.session}' (closed, idle for 30 minutes, or Revit restarted). Open it again.` };
      case "apply": {
        const { BRIDGE_LIMIT_BYTES, applyEnvelope, requestBytes } = await import("./recipebuild.js");
        if (requestBytes("fmc_doc_apply", { ...applyEnvelope(a.session, ""), ops: a.ops }) > BRIDGE_LIMIT_BYTES) return { ok: false, error: "Command timed out after 300 s: fmc_doc_apply" };
        if (!open.has(a.session)) return { ok: false, error: `fmc_doc_apply: No open session '${a.session}'` };
        const done = open.get(a.session)!;
        o.clock.t += (o.msPerOp ?? 100) * a.ops.length;
        for (let i = 1; i <= a.ops.length; i++) {
          const abs = done + i;
          if (abs === o.failOp) return { ok: false, error: `fmc_doc_apply: op ${i} failed, nothing was changed: No reference plane Jamb` };
          if (abs === o.slowOp) {
            o.slowOp = undefined;
            fs.mkdirSync(path.dirname(progressFile(a.session)), { recursive: true });
            fs.writeFileSync(progressFile(a.session), JSON.stringify({ state: "running", started: new Date(o.clock.t - 1000).toISOString(), op: i, kind: a.ops[i - 1].op, name: a.ops[i - 1].name, done: i - 1 }));
            // Revit finishes the chunk after the server stopped waiting
            setTimeout(() => {
              open.set(a.session, done + a.ops.length);
              fs.writeFileSync(progressFile(a.session), JSON.stringify({ state: "finished", started: new Date(o.clock.t - 1000).toISOString(), op: a.ops.length, done: a.ops.length, result: { created: a.ops.length, updated: 0, skipped: 0, warnings: 0 } }));
            }, 0);
            return { ok: false, error: "Revit hasn't answered fmc_doc_apply in 50 s: it is busy, or waiting for its window to wake." };
          }
        }
        if (a.dry_run === false) open.set(a.session, done + a.ops.length);
        return { ok: true, created: a.ops.length, updated: 0, skipped: 0, warnings: [] };
      }
      case "close": { const had = open.delete(a.session); return had ? { ok: true, closed: true, unsaved_changes_discarded: true } : { ok: true, closed: false, reason: "No such session" }; }
      case "background": return { ok: true, sessions: [...open.keys()].map((s) => ({ session: s, title: `Family${s.slice(1)}`, closable: true })), other_background: [{ title: "Family3", path: "" }] };
      case "flex": return { ok: true, types: [{ type: "900x2100", ok: true }], dimension_sides: { checked: 2, unrecorded: 0 } };
      case "save": fs.mkdirSync(path.dirname(a.path), { recursive: true }); fs.writeFileSync(a.path, "rfa"); return { ok: true, saved: a.path };
    }
    return { ok: false, error: "unknown" };
  };
  return { doc, calls, open };
}

test("F-029/F-040: a whole build bigger than the bridge is refused before Revit; a stepwise build runs in chunks across calls and resumes", async () => {
  const { buildRecipe } = await import("../tools/fmc_recipe_build.js");
  const { readBuilds } = await import("./recipebuild.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-build-"));
  const clock = { t: Date.parse("2026-10-15T10:00:00Z") };
  const revit = fakeRevit({ appData: dir, clock });
  const recipe = recipeFile("FMC_A_Door_SteelFanlight.recipe.json");
  const base = { recipeFile: "r.json", template: "Metric Door.rft", target: path.join(dir, "A", `${recipe.family}.rfa`), overwrite: false,
    chunkSize: 20, reportsDir: dir, sharedParameterFile: "", notes: [], sources: {} };
  const deps = { doc: revit.doc, gate: async () => ({ verdict: "Pass", lines: [] }), now: () => clock.t, budgetMs: 35000, appData: dir };

  const whole = await buildRecipe(recipe, { ...base, dry: true, stepwise: false, resume: false }, deps);
  assert.equal(whole.isError, true);
  assert.match(String((whole.body.reasons as string[])[0]), /KB in one call; the Revit bridge reads 8192/);
  assert.equal(revit.calls.length, 0, "nothing reached Revit");

  // A dry run: 402 ops at 100 ms each is 40 s, so the first call stops after a few chunks and says how far it got.
  let r = await buildRecipe(recipe, { ...base, dry: true, stepwise: true, resume: false }, deps);
  assert.equal(r.body.state, "paused");
  assert.match(String(r.body.next), /resume: true to carry on from op \d+/);
  const first = readBuilds(dir)[recipe.family];
  assert.ok(first.last_good_op > 0 && first.last_good_op < recipe.ops.length);
  let guard = 0;
  while (r.body.state === "paused" && guard++ < 20) r = await buildRecipe(recipe, { ...base, dry: true, stepwise: true, resume: true }, deps);
  assert.equal(r.body.dry_run, true);
  assert.equal(r.body.created, recipe.ops.length);
  assert.equal(r.body.template_closed, true);
  assert.equal(revit.open.size, 0, "the dry run's template is closed without saving");
  assert.ok(revit.calls.filter((c) => c.action === "open").length === 1, "one template for the whole stepwise dry run");
  assert.ok(revit.calls.filter((c) => c.action === "apply").every((c) => c.dry_run === false && c.ops.length <= 20));
  assert.ok(!revit.calls.some((c) => c.action === "save"), "a dry run never saves");
  assert.equal(readBuilds(dir)[recipe.family].state, "dry run done");
});

test("F-029/F-040: a failing op closes the template, names the op in the whole recipe, and resume rebuilds the good ops first", async () => {
  const { buildRecipe, cleanupBackground } = await import("../tools/fmc_recipe_build.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-build-"));
  const clock = { t: Date.parse("2026-10-15T10:00:00Z") };
  const revit = fakeRevit({ appData: dir, clock, failOp: 47, msPerOp: 10 });
  const recipe = recipeFile("FMC_A_Door_TimberFanlight.recipe.json");
  const base = { recipeFile: "r.json", template: "Metric Door.rft", target: path.join(dir, "A", `${recipe.family}.rfa`), overwrite: false,
    chunkSize: 20, reportsDir: dir, sharedParameterFile: "", notes: [], sources: {}, stepwise: true };
  const deps = { doc: revit.doc, gate: async () => ({ verdict: "Pass", lines: [] }), now: () => clock.t, budgetMs: Infinity, appData: dir };

  const failed = await buildRecipe(recipe, { ...base, dry: false, resume: false }, deps);
  assert.equal(failed.isError, true);
  assert.equal((failed.body.failed_at as any).op, 47);
  assert.match((failed.body.failed_at as any).text, /op 47 failed/);
  assert.equal(failed.body.template_closed, true);
  assert.equal(revit.open.size, 0, "closed without saving");
  assert.ok(String(failed.body.ops_done).startsWith("40 of"));
  assert.match((failed.body.next as string[]).join(" "), /resume: true to rebuild ops 1-40 and carry on from op 41/);
  assert.deepEqual(failed.body.other_background, [{ title: "Family3", path: "" }]);

  // The recipe is fixed: resume reopens the template, rebuilds ops 1-40 and carries on to a saved family and Gate A.
  const built = await buildRecipe(recipe, { ...base, dry: false, resume: true }, { ...deps, doc: fakeRevit({ appData: dir, clock, msPerOp: 10 }).doc });
  assert.equal(built.isError, false, JSON.stringify(built.body));
  assert.equal(built.body.built, base.target);
  assert.ok(fs.existsSync(base.target.replace(/\.rfa$/, ".recipe.json")));

  // A resume refuses when the ops it already built have changed.
  const changed = { ...recipe, ops: [{ op: "set_category", name: "OST_Windows" }, ...recipe.ops.slice(1)] } as typeof recipe;
  const again = await buildRecipe(recipe, { ...base, dry: false, resume: false }, { ...deps, doc: fakeRevit({ appData: dir, clock, failOp: 30, msPerOp: 10 }).doc });
  assert.equal(again.isError, true);
  const refused = await buildRecipe(changed, { ...base, dry: false, resume: true }, deps);
  assert.match(String((refused.body.reasons as string[])[0]), /Ops 1-20 .* changed since that build/);

  // cleanup: a dry run lists, then closes only what a Formcraft session opened
  const leftover = fakeRevit({ appData: dir, clock });
  await leftover.doc({ action: "open", template: "Metric Door.rft" });
  const list = await cleanupBackground(true, dir, leftover.doc);
  assert.equal((list.body.would_close as unknown[]).length, 1);
  assert.equal(leftover.open.size, 1);
  const closed = await cleanupBackground(false, dir, leftover.doc);
  assert.equal((closed.body.closed as any[])[0].closed, true);
  assert.equal(leftover.open.size, 0);
});

test("F-029: a chunk Revit is still working on is reported with its op, and resume picks up its result from the progress file", async () => {
  const { buildRecipe } = await import("../tools/fmc_recipe_build.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-build-"));
  const clock = { t: Date.parse("2026-10-15T10:00:00Z") };
  const revit = fakeRevit({ appData: dir, clock, slowOp: 25, msPerOp: 10 });
  const recipe = recipeFile("FMC_A_Window_AluVent.recipe.json");
  const base = { recipeFile: "r.json", template: "Metric Window.rft", target: path.join(dir, "A", `${recipe.family}.rfa`), overwrite: false,
    chunkSize: 20, reportsDir: dir, sharedParameterFile: "", notes: [], sources: {}, stepwise: true, dry: true };
  const deps = { doc: revit.doc, gate: async () => ({ verdict: "Pass", lines: [] }), now: () => clock.t, budgetMs: Infinity, appData: dir };
  const r = await buildRecipe(recipe, { ...base, resume: false }, deps);
  assert.equal(r.body.state, "running in Revit");
  assert.match(String(r.body.at), /started op 25 \(/);
  await new Promise((res) => setTimeout(res, 5));
  const done = await buildRecipe(recipe, { ...base, resume: true }, deps);
  assert.equal(done.body.dry_run, true, JSON.stringify(done.body));
  assert.equal(revit.open.size, 0);
});

// ---------------------------------------------------------------- fully parametric sweeps (path_planes)

const allRecipes = () => fs.readdirSync(path.join(REPO, "tests", "recipes")).filter((f) => f.endsWith(".recipe.json")).map((f) => ({ f, r: recipeFile(f) }));

test("every sweep in tests/recipes is on path_planes (no fixed path), so a trim that doesn't follow Width/Height can't come back", async () => {
  const { opsProblems, splitProblems } = await import("./ops.js");
  const { templatePlanes } = await import("./recipebuild.js");
  let sweeps = 0;
  for (const { f, r } of allRecipes()) {
    const ops = r.ops as Array<Record<string, any>>;
    for (const o of ops.filter((x) => x.op === "sweep" || x.op === "void_sweep")) {
      sweeps++;
      assert.ok(Array.isArray(o.path_planes) && o.path_planes.length >= 2, `${f}: ${o.op} "${o.name}" has no path_planes`);
      assert.equal(o.path, undefined, `${f}: ${o.op} "${o.name}" still has a fixed path`);
    }
    // the planes are the template's or made earlier: no error other than the missing dictionary
    const { errors } = splitProblems(opsProblems(r.ops, null, "Z:\\00_Standards\\04_Families", undefined, { templatePlanes: templatePlanes(r.template).planes }));
    assert.ok(errors.every((e) => /shared parameter file isn't readable/.test(e)), `${f}: ${errors.filter((e) => !/shared parameter/.test(e)).join(" | ")}`);
    // load_family paths are relative to the kit's family roots, so the recipe works on any PC (Z:, D:)
    for (const o of ops.filter((x) => x.op === "load_family")) assert.ok(!/^[A-Za-z]:|^\\/.test(o.path), `${f}: ${o.name} loads from ${o.path}`);
  }
  assert.ok(sweeps >= 161, `${sweeps} sweeps`); // flush 40 + its frame, two fanlight doors 40 each, two windows 20 each
});

test("the opening recipes stay size first (F-026) and the trims sit on the family's own planes", () => {
  for (const f of ["FMC_A_Door_FlushSingleLeaf", "FMC_A_Door_TimberFanlight", "FMC_A_Door_SteelFanlight", "FMC_A_Window_SteelCasementVent", "FMC_A_Window_AluVent"]) {
    const r = recipeFile(`${f}.recipe.json`);
    const ops = r.ops as Array<Record<string, any>>;
    const firstPlane = ops.findIndex((o) => o.op === "add_ref_plane");
    const t1 = ops.find((o) => o.op === "add_type")!.name;
    assert.ok(ops.findIndex((o) => o.op === "add_type" && o.name === t1) < firstPlane, `${f}: type 1 before the planes`);
    for (const p of ["Width", "Height"])
      assert.ok(ops.findIndex((o) => o.op === "set_type_value" && o.type === t1 && o.param === p) < firstPlane, `${f}: ${p} before the planes`);
    const trims = ops.filter((o) => o.op === "sweep" && / (Ext|Int)$/.test(o.name));
    assert.ok(trims.length >= 20);
    for (const s of trims) {
      const used = new Set((s.path_planes as string[][]).flat());
      assert.ok(used.has("Left") && used.has("Right"), `${f}: ${s.name} on Left and Right`);
      assert.ok(s.path_host, `${f}: ${s.name} hosted on a face plane`);
      assert.ok(ops.some((o) => o.op === "add_ref_plane" && o.name === s.path_host), `${f}: ${s.path_host} drawn by the recipe`);
    }
  }
});

test("flex follow: Width, Height and Fanlight Height are exercised; each trim is governed by Width/Height through its planes", async () => {
  const { expectedFollows, followParams, planeParams } = await import("./recipes.js");
  const steel = recipeFile("FMC_A_Door_SteelFanlight.recipe.json");
  const fp = followParams(steel);
  assert.deepEqual(fp.map((p) => p.param).sort(), ["Fanlight Height", "Height", "Width"]);
  const w = fp.find((p) => p.param === "Width")!;
  assert.ok(w.low_mm < w.high_mm && !w.stepped);
  const pp = planeParams(steel);
  assert.deepEqual([...pp.get("Frame Head")!], ["Height"]);
  assert.deepEqual([...pp.get("Leaf Top")!].sort(), ["Fanlight Height", "Height"]);
  const exp = expectedFollows(steel, fp);
  assert.deepEqual(exp.get("Architrave Contemporary Ext"), ["Width", "Height"]);
  // A one-type family is still flexed: Width and Height move 10% up.
  const flush = recipeFile("FMC_A_Door_FlushSingleLeaf.recipe.json");
  const ff = followParams(flush);
  assert.deepEqual(ff.find((p) => p.param === "Width"), { param: "Width", low_mm: 900, high_mm: 990, stepped: true });
  assert.deepEqual(expectedFollows(flush, ff).get("Frame"), ["Width", "Height"]);
  const win = recipeFile("FMC_A_Window_AluVent.recipe.json");
  assert.deepEqual(expectedFollows(win).get("Surround Greek Ext"), ["Width", "Height"]);
});

test("Gate A: a sweep that doesn't move with its governing parameter fails; every solid says what it follows", () => {
  const r = parseRecipe(JSON.stringify({ family: "FMC_A_Window_X", template: "Metric Window.rft", ops: [
    { op: "add_type", name: "A" }, { op: "add_type", name: "B" },
    { op: "set_type_value", name: "A/Width", type: "A", param: "Width", value: 600 },
    { op: "set_type_value", name: "B/Width", type: "B", param: "Width", value: 1800 },
    { op: "set_type_value", name: "A/Height", type: "A", param: "Height", value: 900 },
    { op: "set_type_value", name: "B/Height", type: "B", param: "Height", value: 1500 },
    { op: "add_ref_plane", name: "Face", from: [-2000, -130], to: [2000, -130] },
    { op: "sweep", name: "Trim", path_planes: [["Left", "Sill"], ["Left", "Head"], ["Right", "Head"], ["Right", "Sill"]], path_host: "Face", path_plane: "front", profile: [[0, 0], [10, 0], [10, 10]] },
    { op: "extrusion", name: "Jamb", rect: ["Left", "Right", "Face", "Center (Front/Back)"], end: 100 },
  ] })).recipe!;
  const flex = (moved: Record<string, string[]>) => ({ ok: true, types: [{ type: "A", ok: true }], dimension_sides: { checked: 0, unrecorded: 0 },
    follow: { params: [{ param: "Width", ok: true, low_mm: 600, high_mm: 1800 }, { param: "Height", ok: true, low_mm: 900, high_mm: 1500 }],
      elements: Object.entries(moved).map(([name, m]) => ({ name, moved: m, fixed: ["Width", "Height"].filter((p) => !m.includes(p)) })) } });
  const good = gateA("FMC_A_Window_X", r, { inspect: passInspect, registerCategory: "Windows", flex: flex({ Trim: ["Width", "Height"], Jamb: ["Width"] }) });
  const line = good.lines.find((l) => l.check === "Solids and sweeps follow the size parameters")!;
  assert.equal(line.state, "Pass", line.detail);
  assert.match(line.detail, /follows Width\/Height: 1 \(Trim\)/);
  assert.deepEqual(good.follows!.map((x) => [x.solid, x.follows, x.state]), [["Trim", "follows Width/Height", "Pass"], ["Jamb", "follows Width", "Pass"]]);
  const bad = gateA("FMC_A_Window_X", r, { inspect: passInspect, registerCategory: "Windows", flex: flex({ Trim: ["Width"], Jamb: ["Width"] }) });
  const b = bad.lines.find((l) => l.check === "Solids and sweeps follow the size parameters")!;
  assert.equal(b.state, "Fail");
  assert.match(b.detail, /Trim follows Width, but its planes move with Width\/Height/);
  assert.equal(bad.verdict, "Fail");
  // An add-in without the follow report: not checked, never passed.
  const old = gateA("FMC_A_Window_X", r, { inspect: passInspect, registerCategory: "Windows", flex: passFlex });
  assert.equal(old.lines.find((l) => /follow the size/.test(l.check))!.state, "Not checked");
});

test("F-046: cleanup closes stale sessions and left-overs (dry run first), keeps an unfinished build's live one and the person's, and forgets lost ledger entries", async () => {
  const { cleanupBackground } = await import("../tools/fmc_recipe_build.js");
  const { writeBuild } = await import("./recipebuild.js");
  const { readLedger, writeLedger } = await import("./doc.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-stale-"));
  const now = new Date("2026-10-15T10:00:00Z");
  // two builds waiting for a resume: one used 20 minutes ago, one idle 13 hours
  writeBuild(dir, { family: "FMC_A_Door_Live", state: "waiting", session: "live", sessions: ["live"] } as any);
  writeBuild(dir, { family: "FMC_A_Door_Old", state: "waiting", session: "old", sessions: ["old"] } as any);
  writeLedger(dir, Object.fromEntries(["live", "old", "window", "orphan", "gone"].map((id) => [id, { id, source: "x.rft", opened: "2026-10-14T11:31:00Z", ops: [] }])));
  const sessions = [
    { session: "live", title: "Family1", closable: true, idle_minutes: 20 },
    { session: "old", title: "Family2", closable: true, idle_minutes: 13 * 60 },
    { session: "window", title: "FMC_A_Door_X", closable: false, idle_minutes: 30 * 60, reason: "shown in a Revit window: it stays" },
    { session: "orphan", title: "Family4", closable: true, used: "2026-10-15T09:00:00Z" },
  ];
  const closed: string[] = [];
  const doc = async (a: Record<string, any>): Promise<any> =>
    a.action === "background" ? { ok: true, sessions, other_background: [] }
      : a.action === "close" ? (closed.push(a.session), { ok: true, closed: true, unsaved_changes_discarded: true }) : { ok: false, error: "unexpected" };

  const dry = await cleanupBackground(true, dir, doc, 12, now);
  const would = dry.body.would_close as any[];
  assert.deepEqual(would.map((s) => s.session), ["old", "orphan"]);
  assert.match(would[0].why, /stale: idle 13 h, over the 12 h limit/);
  assert.match(would[1].why, /left open by an earlier call/);
  const stays = dry.body.stays_open as any[];
  assert.deepEqual(stays.map((s) => s.session), ["live", "window"]);
  assert.match(stays[0].reason, /in use by the FMC_A_Door_Live build \(waiting\), idle 0.3 h of 12 h/);
  assert.match(stays[1].reason, /Revit window/, "the person's document is never closed");
  assert.deepEqual(dry.body.would_forget, ["gone"]);
  assert.equal(closed.length, 0, "a dry run closes nothing");
  assert.equal(Object.keys(readLedger(dir)).length, 5);

  const real = await cleanupBackground(false, dir, doc, 12, now);
  assert.deepEqual(closed, ["old", "orphan"]);
  assert.deepEqual((real.body.closed as any[]).map((c) => c.closed), [true, true]);
  assert.deepEqual(Object.keys(readLedger(dir)).sort(), ["live", "window"]);
});

test("a nested helper's missing keynote is exempt only when its recipe says why", () => {
  const noKeynote = { ...passInspect, checks: [...passInspect.checks, { check: "Keynote set", state: "fail", detail: "1 of 1 types have no keynote" }] };
  const plain = gateA("FMC_A_Door_SteelFanlight", parseRecipe(door()).recipe, { inspect: noKeynote, flex: passFlex, registerCategory: "Doors" });
  const kn = (g: ReturnType<typeof gateA>) => g.lines.find((l) => /keynote/i.test(l.check))!;
  assert.equal(kn(plain).state, "Fail");
  const exempt = gateA("FMC_A_Door_SteelFanlight", parseRecipe(door({ checks: { keynote_exempt: "nested service point, never scheduled" } })).recipe,
    { inspect: noKeynote, flex: passFlex, registerCategory: "Doors" });
  assert.equal(kn(exempt).state, "Pass");
  assert.match(kn(exempt).detail, /^Exempt: nested service point, never scheduled/);
});

test("QS01: the level-of-detail ladder is read from the recipe: Coarse box LOD 100, standard LOD 200, detailed LOD 300, Rhino twins LOD 400", () => {
  const env = { op: "extrusion", name: "Coarse Envelope", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 900 };
  const body = { op: "revolution", name: "Wheel", profile: [[0, 0], [50, 0], [0, 40]] };
  const vis = (name: string, coarse: boolean, medium: boolean, fine: boolean) => ({ op: "set_visibility", name, coarse, medium, fine });
  const standard = [env, body, vis("Coarse Envelope", true, false, false), vis("Wheel", false, true, true)];
  assert.deepEqual(lodLadder("FMC_I_Bed", standard), { coarse: "LOD 100", medium: "LOD 200", fine: "LOD 200" });
  assert.equal(lodLine("FMC_I_Bed", standard).state, "Pass");
  const detailed = [env, body, vis("Coarse Envelope", true, false, false), vis("Wheel", false, true, true)];
  assert.equal(lodLine("FMC_I_Bed_Detailed", detailed).state, "Warn", "a detailed family without twins: LOD 300 on Fine");
  const twins = [env, body, vis("Coarse Envelope", true, false, false), vis("Wheel", false, true, false),
    { op: "import_part", name: "Wheel Fine", file: "D:\K\_Rhino\F\Wheel.3dm" }, vis("Wheel Fine", false, false, true)];
  assert.deepEqual(lodLadder("FMC_I_Bed_Detailed", twins), { coarse: "LOD 100", medium: "LOD 300", fine: "LOD 400 + Render" });
  assert.equal(lodLine("FMC_I_Bed_Detailed", twins).state, "Pass");
  const noCoarse = [body];
  assert.match(lodLine("FMC_A_Door", noCoarse).detail, /Coarse LOD 200.*expected LOD 100/, "a body on Coarse with no envelope is reported");
  assert.equal(lodLine("FMC_A_Door", [env, vis("Coarse Envelope", true, false, false)]).state, "Fail", "Medium shows nothing");
});
