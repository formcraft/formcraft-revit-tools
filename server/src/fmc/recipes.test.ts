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
