import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EvolveFacts, EvolveKit, KEYNOTE_FORMAT, applyProblems, diffFacts, diffGates, evaluateGates, expectedAfter, flexRegressions, isUnnamedPlane,
  isEvolveDir, normalizeKeynote, orderedOps, planVersions, positionalPlaneName, proposalToken, readVersions, suggestFamilyName, underEvolveFolder,
} from "./evolve.js";
import { KEYNOTE_RE } from "./replace.js";
import { OP, opsProblems, splitProblems } from "./ops.js";
import { EvolveIo, FMC_FAMILY_EVOLVE_SHAPE, registerFmcFamilyEvolveTool, runFmcFamilyEvolve } from "../tools/fmc_family_evolve.js";
import { z } from "zod";
import type { GuardConfig } from "./policy.js";
import { stagedRecipes } from "../tools/fmc_changes.js";

const win = path.win32;
const STAGING = "Z:\\00_Standards\\04_Families\\_Staging";
const RELEASED = "Z:\\00_Standards\\04_Families\\A";
const G_TAG = "11111111-1111-1111-1111-111111111111";
const G_CODE = "22222222-2222-2222-2222-222222222222";
const G_FOREIGN = "99999999-9999-9999-9999-999999999999";

const cfg = {
  write_roots: [STAGING], library_roots: [STAGING], template_roots: [], blocked_segments: ["02_Shared", "03_Published", "04_Archive", "05_Incoming"],
  family_staging_root: STAGING, reports_dir: "C:\\FMC_Reports_test", max_backups: 3, live_model_lock: true,
} as unknown as GuardConfig;

function kit(over: Partial<EvolveKit> = {}): EvolveKit {
  const dictionary = new Map([
    ["FMC_Asset_Tag", { name: "FMC_Asset_Tag", guid: G_TAG, datatype: "TEXT", group: "FMC" }],
    ["FMC_Product_Code", { name: "FMC_Product_Code", guid: G_CODE, datatype: "TEXT", group: "FMC" }],
  ]);
  const spec = { family: "FMC_A_Door_SteelFanlight", role: "A", category: "Doors", shared_parameters: [{ name: "FMC_Asset_Tag", binding: "instance", guid: null }, { name: "FMC_Product_Code", binding: "type", guid: null }] };
  return { dictionary, specs: new Map([[spec.family, spec as any]]), keynotes: new Set(["A.DOR_01", "A.DOR_02"]), ...over };
}

function facts(over: Partial<EvolveFacts> = {}): EvolveFacts {
  return {
    file: win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa"), family: "FMC_A_Door_SteelFanlight", category: "Doors",
    parameters: [{ name: "FMC_Asset_Tag", shared: true, guid: G_TAG, instance: true }, { name: "FMC_Product_Code", shared: true, guid: G_CODE, instance: false }, { name: "Width", shared: false, guid: "" }],
    types: ["900x2100_Std", "1000x2100_Std"],
    type_keynotes: [{ type: "900x2100_Std", keynote: "A.DOR_01" }, { type: "1000x2100_Std", keynote: "A.DOR_01" }],
    reference_planes: ["Center (Left/Right)", "Left", "Right"],
    reference_planes_detail: [{ name: "Center (Left/Right)", axis: "x", at_mm: 0 }, { name: "Left", axis: "x", at_mm: -450 }, { name: "Right", axis: "x", at_mm: 450 }],
    flex: { ok: true, types: [{ type: "900x2100_Std", ok: true }, { type: "1000x2100_Std", ok: true }] },
    ...over,
  };
}
const gate = (ev: ReturnType<typeof evaluateGates>, g: string) => ev.gates.find((x) => x.gate === g)!;

// ---------- rules ----------

test("the keynote format is fmc_replace's X.YYY_ZZ", () => {
  assert.equal(KEYNOTE_FORMAT.source, KEYNOTE_RE.source);
  for (const ok of ["S.FND_01", "A.DOR_01", "E.LT1_0A"]) assert.equal(KEYNOTE_FORMAT.test(ok), true, ok);
  for (const bad of ["SFND_01", "s.fnd_01", "S.FND-01", "S.FN_01", "S.FNDX_01", "S.FND_001", "", "foundation"]) assert.equal(KEYNOTE_FORMAT.test(bad), false, bad);
});

test("a keynote close to X.YYY_ZZ is normalised, anything else is left to a person", () => {
  assert.equal(normalizeKeynote("s.fnd_01"), "S.FND_01");
  assert.equal(normalizeKeynote(" S.FND-01 "), "S.FND_01");
  assert.equal(normalizeKeynote("S FND 01"), "S.FND_01");
  assert.equal(normalizeKeynote("S-FND/01"), "S.FND_01");
  assert.equal(normalizeKeynote("S.FND_01"), "S.FND_01");
  assert.equal(normalizeKeynote("foundation"), null);
  assert.equal(normalizeKeynote("SFND01"), null);
  assert.equal(normalizeKeynote(""), null);
});

test("blank and Revit's default plane names are unnamed", () => {
  assert.equal(isUnnamedPlane(""), true);
  assert.equal(isUnnamedPlane("Reference Plane"), true);
  assert.equal(isUnnamedPlane(" reference plane "), true);
  assert.equal(isUnnamedPlane(null), true);
  assert.equal(isUnnamedPlane("Head"), false);
  assert.equal(positionalPlaneName({ axis: "x", at_mm: 450 }), "RP_X+450");
  assert.equal(positionalPlaneName({ axis: "z", at_mm: -120.46 }), "RP_Z-120.5");
});

test("a name close to the kit's rule is suggested; one too far is not", () => {
  assert.equal(suggestFamilyName("A_Door_steel fanlight", "Doors"), "FMC_A_Door_SteelFanlight");
  assert.equal(suggestFamilyName("fmc-a-door-steel", "Doors"), "FMC_A_Door_Steel");
  assert.equal(suggestFamilyName("Steel Door", "Doors"), null);
  assert.equal(suggestFamilyName("Door1", "Doors"), null);
  // a role code the manual doesn't have is never suggested
  assert.equal(suggestFamilyName("XX_Door_Steel", "Doors"), null);
});

// ---------- gates ----------

test("a family that meets the kit passes every gate and proposes nothing", () => {
  const ev = evaluateGates(facts(), kit());
  assert.deepEqual(ev.gates.map((g) => [g.gate, g.state]), [["naming", "Pass"], ["shared_parameters", "Pass"], ["reference_planes", "Pass"], ["flex", "Pass"], ["keynote", "Pass"]]);
  assert.deepEqual(ev.fixes, []);
  assert.deepEqual(ev.needs_person, []);
  assert.equal(ev.target_name, "FMC_A_Door_SteelFanlight");
});

test("naming: a near name gets a suggested new version name, new_name wins, a bad new_name is refused", () => {
  const f = facts({ family: "A_Door_SteelFanlight" });
  const ev = evaluateGates(f, kit());
  assert.equal(gate(ev, "naming").state, "Fail");
  assert.equal(ev.target_name, "FMC_A_Door_SteelFanlight");
  assert.equal(ev.fixes.find((x) => x.id === "naming.rename")!.rename_to, "FMC_A_Door_SteelFanlight");
  const chosen = evaluateGates(f, kit(), { new_name: "FMC_A_Door_SteelFanlightV2" });
  assert.equal(chosen.target_name, "FMC_A_Door_SteelFanlightV2");
  const bad = evaluateGates(f, kit(), { new_name: "Door with spaces" });
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /naming rule/);
  const far = evaluateGates(facts({ family: "Steel Door" }), kit());
  assert.equal(far.needs_person.filter((n) => n.gate === "naming").length, 1);
  assert.equal(far.fixes.some((x) => x.gate === "naming"), false);
});

test("shared parameters: missing ones are added, a family parameter is bound, another GUID needs a person", () => {
  const f = facts({ parameters: [{ name: "FMC_Asset_Tag", shared: false, guid: "", instance: true }, { name: "Width", shared: false, guid: "" }] });
  const ev = evaluateGates(f, kit());
  const g = gate(ev, "shared_parameters");
  assert.equal(g.state, "Fail");
  assert.match(g.detail, /0 of 2 present/);
  const bind = ev.fixes.find((x) => x.id === "shared_parameters.bind")!;
  assert.deepEqual(bind.ops, [{ op: "bind_shared_param", name: "FMC_Asset_Tag", guid: G_TAG, instance: true }]);
  const add = ev.fixes.find((x) => x.id === "shared_parameters.add")!;
  assert.deepEqual(add.ops, [{ op: "add_shared_param", name: "FMC_Product_Code", guid: G_CODE, instance: false, group: "Data" }]);
  const other = evaluateGates(facts({ parameters: [{ name: "FMC_Asset_Tag", shared: true, guid: G_FOREIGN }, { name: "FMC_Product_Code", shared: true, guid: G_CODE }] }), kit());
  assert.equal(gate(other, "shared_parameters").state, "Fail");
  assert.equal(other.needs_person.filter((n) => n.gate === "shared_parameters").length, 1);
  assert.equal(other.fixes.some((x) => x.gate === "shared_parameters"), false);
});

test("shared parameters never pass on nothing; a foreign GUID is a warning; required_parameters add to the spec", () => {
  const none = evaluateGates(facts({ family: "FMC_A_Door_Unlisted" }), kit());
  assert.equal(gate(none, "shared_parameters").state, "Not checked");
  const extra = evaluateGates(facts({ family: "FMC_A_Door_Unlisted", parameters: [{ name: "X", shared: true, guid: G_FOREIGN }] }), kit(), { required_parameters: ["FMC_Asset_Tag"] });
  const g = gate(extra, "shared_parameters");
  assert.equal(g.state, "Fail");
  assert.ok(g.findings.some((x) => /isn't in the kit's dictionary/.test(x)));
  assert.equal(extra.fixes.find((x) => x.id === "shared_parameters.add")!.ops.length, 1);
  const unknown = evaluateGates(facts(), kit(), { required_parameters: ["Not_In_Kit"] });
  assert.match(unknown.problems[0], /kit change request/);
  const noDict = evaluateGates(facts(), kit({ dictionary: null }));
  assert.equal(gate(noDict, "shared_parameters").state, "Not checked");
});

test("reference planes: given names and positional names become name_template_plane ops; twins need a person", () => {
  const detail = [{ name: "Left", axis: "x" as const, at_mm: -450 }, { name: "Reference Plane", axis: "z" as const, at_mm: 2100 }, { name: "", axis: "y" as const, at_mm: 60 },
    { name: "", axis: "" as const, at_mm: 0 }];
  const f = facts({ reference_planes: detail.map((d) => d.name), reference_planes_detail: detail });
  const given = evaluateGates(f, kit(), { plane_names: [{ axis: "z", at_mm: 2100.2, name: "Head" }] });
  assert.equal(gate(given, "reference_planes").state, "Fail");
  assert.deepEqual(given.fixes.find((x) => x.id === "reference_planes.name")!.ops, [{ op: "name_template_plane", name: "Head", axis: "z", at_mm: 2100 }]);
  assert.equal(given.needs_person.filter((n) => n.gate === "reference_planes").length, 2);
  const auto = evaluateGates(f, kit(), { plane_names: [{ axis: "z", at_mm: 2100, name: "Head" }], auto_name_planes: true });
  assert.deepEqual(auto.fixes.find((x) => x.id === "reference_planes.name")!.ops.map((o) => o.name), ["Head", "RP_Y+60"]);
  // the oblique plane can't be found by axis and position
  assert.equal(auto.needs_person.filter((n) => n.gate === "reference_planes").length, 1);
  const twins = evaluateGates(facts({ reference_planes_detail: [{ name: "", axis: "x", at_mm: 10 }, { name: "", axis: "x", at_mm: 10.2 }] }), kit(), { auto_name_planes: true });
  assert.equal(twins.fixes.some((x) => x.gate === "reference_planes"), false);
  const old = evaluateGates(facts({ reference_planes: ["Left", "Reference Plane"], reference_planes_detail: null }), kit());
  assert.equal(gate(old, "reference_planes").state, "Fail");
  assert.match(gate(old, "reference_planes").detail, /update the add-in/);
});

test("flex: failing types fail and go to a person; a flex that didn't run is Not checked; regressions are found", () => {
  const bad = evaluateGates(facts({ flex: { ok: false, types: [{ type: "900x2100_Std", ok: true }, { type: "1000x2100_Std", ok: false, errors: ["Constraints are not satisfied"] }] } }), kit());
  assert.equal(gate(bad, "flex").state, "Fail");
  assert.equal(bad.needs_person.filter((n) => n.gate === "flex").length, 1);
  assert.equal(bad.fixes.some((x) => x.gate === "flex"), false);
  const none = evaluateGates(facts({ flex: null, flexError: "file in use" }), kit());
  assert.equal(gate(none, "flex").state, "Not checked");
  assert.match(gate(none, "flex").detail, /file in use/);
  const moved = evaluateGates(facts({ flex: { ok: true, types: [{ type: "900x2100_Std", ok: true }], follow: { params: [{ param: "Width", ok: true }, { param: "Height", ok: false, error: "no type" }], elements: [{ name: "Leaf", moved: ["Width"], fixed: [] }] } } }), kit());
  assert.equal(gate(moved, "flex").state, "Fail");
  assert.deepEqual(flexRegressions({ types: [{ type: "a", ok: true }, { type: "b", ok: false }] }, { types: [{ type: "a", ok: false, errors: ["x"] }, { type: "b", ok: false }] }), ["a: x"]);
  assert.deepEqual(flexRegressions({ types: [{ type: "a", ok: true }] }, { types: [{ type: "a", ok: true }] }), []);
});

test("keynote: a near keynote is normalised, keynote sets them, a bad keynote option is refused, one not in the kit warns", () => {
  const f = facts({ type_keynotes: [{ type: "900x2100_Std", keynote: "a.dor-01" }, { type: "1000x2100_Std", keynote: "" }] });
  const ev = evaluateGates(f, kit());
  assert.equal(gate(ev, "keynote").state, "Fail");
  assert.deepEqual(ev.fixes.find((x) => x.id === "keynote.set")!.ops, [{ op: "set_type_value", name: "900x2100_Std/Keynote", type: "900x2100_Std", param: "Keynote", value: "A.DOR_01" }]);
  assert.equal(ev.needs_person.filter((n) => n.gate === "keynote").length, 1);
  const all = evaluateGates(f, kit(), { keynote: "A.DOR_02" });
  assert.equal(all.fixes.find((x) => x.id === "keynote.set")!.ops.length, 2);
  assert.equal(all.needs_person.filter((n) => n.gate === "keynote").length, 0);
  const per = evaluateGates(f, kit(), { keynote: { "1000x2100_Std": "A.DOR_02" } });
  assert.equal(per.fixes.find((x) => x.id === "keynote.set")!.ops.length, 2);
  assert.match(evaluateGates(f, kit(), { keynote: "door" }).problems[0], /X\.YYY_ZZ/);
  const notKit = evaluateGates(facts({ type_keynotes: [{ type: "900x2100_Std", keynote: "A.DOR_09" }] }), kit());
  assert.equal(gate(notKit, "keynote").state, "Warn");
  const tb = evaluateGates(facts({ family: "FMC_TitleBlock_A1", category: "Title Blocks", type_keynotes: [{ type: "A1", keynote: "" }] }), kit());
  assert.equal(gate(tb, "keynote").state, "Pass");
  assert.equal(gate(evaluateGates(facts({ type_keynotes: null }), kit()), "keynote").state, "Not checked");
});

// ---------- proposal, preview, diff ----------

test("ops go planes, bind, add, keynote; the token follows the bytes, the target and the ops", () => {
  const f = facts({ parameters: [{ name: "FMC_Asset_Tag", shared: false, guid: "" }], type_keynotes: [{ type: "900x2100_Std", keynote: "a.dor_01" }],
    reference_planes_detail: [{ name: "", axis: "z", at_mm: 2100 }] });
  const ev = evaluateGates(f, kit(), { plane_names: [{ axis: "z", at_mm: 2100, name: "Head" }] });
  assert.deepEqual(orderedOps(ev.fixes).map((o) => o.op), ["name_template_plane", "bind_shared_param", "add_shared_param", "set_type_value"]);
  const ops = orderedOps(ev.fixes);
  const t = proposalToken(f.file, "abc", ev.target_name, ops);
  assert.match(t, /^EV-[0-9a-f]{16}$/);
  assert.equal(proposalToken(f.file.toUpperCase(), "abc", ev.target_name, ops), t);
  assert.notEqual(proposalToken(f.file, "abd", ev.target_name, ops), t);
  assert.notEqual(proposalToken(f.file, "abc", "FMC_A_Door_Other", ops), t);
  assert.notEqual(proposalToken(f.file, "abc", ev.target_name, ops.slice(1)), t);
  // every op the evolve tool proposes is one fmc_doc accepts
  for (const o of ops) assert.equal(OP.safeParse(o).success, true, JSON.stringify(o));
});

test("the preview says what each gate becomes; diffGates and diffFacts say what changed", () => {
  const f = facts({ parameters: [], type_keynotes: [{ type: "900x2100_Std", keynote: "" }] });
  const ev = evaluateGates(f, kit());
  const exp = expectedAfter(ev, new Set(ev.fixes.map((x) => x.id)));
  assert.equal(exp.find((e) => e.gate === "shared_parameters")!.expected, "Pass");
  assert.equal(exp.find((e) => e.gate === "keynote")!.expected, "Fail");
  assert.equal(expectedAfter(ev, new Set()).find((e) => e.gate === "shared_parameters")!.expected, "Fail");
  const after = facts();
  const diff = diffGates(ev.gates, evaluateGates(after, kit()).gates);
  assert.equal(diff.find((d) => d.gate === "shared_parameters")!.change, "fixed");
  assert.equal(diff.find((d) => d.gate === "naming")!.change, "same");
  assert.equal(diffGates([{ gate: "flex", state: "Pass", detail: "", findings: [] }], [{ gate: "flex", state: "Fail", detail: "", findings: [] }]).find((d) => d.gate === "flex")!.change, "regressed");
  const ch = diffFacts(f, after);
  assert.deepEqual(ch.parameters_added, [`FMC_Asset_Tag (${G_TAG})`, `FMC_Product_Code (${G_CODE})`, "Width"]);
  assert.equal(ch.keynotes.length, 2);
  assert.equal(ch.name, null);
});

// ---------- versions and backups ----------

test("versions: beside a staging file, in staging for a released one; the backup is reused for the same bytes", () => {
  const src = win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa");
  const p = planVersions(src, "sha1", "FMC_A_Door_SteelFanlight", cfg, []);
  assert.equal(p.dir, win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight"));
  assert.equal(p.backup.path, win.join(p.dir, "v001", "FMC_A_Door_SteelFanlight.rfa"));
  assert.equal(p.target.path, win.join(p.dir, "v002", "FMC_A_Door_SteelFanlight.rfa"));
  assert.deepEqual(p.problems, []);
  const again = planVersions(src, "sha1", "FMC_A_Door_SteelFanlight", cfg, [{ n: 1, file: p.backup.path, sha256: "sha1", backup: true }, { n: 2, file: p.target.path, sha256: "sha2", backup: false }]);
  assert.equal(again.backup.reuse, true);
  assert.equal(again.target.path, win.join(p.dir, "v003", "FMC_A_Door_SteelFanlight.rfa"));
  const changed = planVersions(src, "sha9", "FMC_A_Door_SteelFanlight", cfg, [{ n: 1, file: p.backup.path, sha256: "sha1", backup: true }, { n: 2, file: p.target.path, sha256: "sha2", backup: false }]);
  assert.equal(changed.backup.path, win.join(p.dir, "v003", "FMC_A_Door_SteelFanlight.rfa"));
  assert.equal(changed.target.path, win.join(p.dir, "v004", "FMC_A_Door_SteelFanlight.rfa"));
  const released = planVersions(win.join(RELEASED, "FMC_A_Door_SteelFanlight.rfa"), "s", "FMC_A_Door_SteelFanlight", cfg, []);
  assert.equal(released.dir, win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight"));
  assert.deepEqual(released.problems, []);
  const renamed = planVersions(src, "s", "FMC_A_Door_SteelFanlightV2", cfg, []);
  assert.equal(win.basename(renamed.target.path), "FMC_A_Door_SteelFanlightV2.rfa");
  const nowhere = planVersions(src, "s", "FMC_A_Door_SteelFanlight", { ...cfg, write_roots: [], family_staging_root: "Z:\\Elsewhere" } as GuardConfig, []);
  assert.ok(nowhere.problems.some((x) => /write folder/.test(x)));
  const badName = planVersions(src, "s", "Steel Door", cfg, []);
  assert.ok(badName.problems.some((x) => /^new version: /.test(x)));
});

test("readVersions reads vNNN folders, skips Revit's .0001 backups and other folders", () => {
  const dir = "Z:\\x\\_Evolve\\F";
  const v = readVersions([{ folder: "v002", files: ["F2.rfa", "F2.0001.rfa", "F2.evolve.json"] }, { folder: "v001", files: ["F.rfa"] }, { folder: "notes", files: ["a.rfa"] }, { folder: "v003", files: [] }],
    dir, new Map([["v001", { backup: true, sha256: "s1" }]]), () => "computed");
  assert.deepEqual(v.map((x) => [x.n, win.basename(x.file), x.sha256, x.backup]), [[1, "F.rfa", "s1", true], [2, "F2.rfa", "computed", false]]);
});

test("staging scanners recognise an _Evolve folder in any case, and a path under one", () => {
  assert.equal(isEvolveDir("_Evolve"), true);
  assert.equal(isEvolveDir(" _evolve "), true);
  assert.equal(isEvolveDir("_Evolve_bak"), false);
  assert.equal(isEvolveDir("Evolve"), false);
  assert.equal(isEvolveDir(""), false);
  assert.equal(underEvolveFolder(win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight", "v001", "FMC_A_Door_SteelFanlight.rfa")), true);
  assert.equal(underEvolveFolder(win.join(STAGING, "_Evolve", "x.rfa")), true);
  assert.equal(underEvolveFolder(win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa")), false);
  assert.equal(underEvolveFolder(win.join(STAGING, "A", "_Images", "preview.png")), false);
});

test("stagedRecipes walks staging but never a family or recipe under _Evolve", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-evolve-scan-"));
  const recipe = JSON.stringify({ schema: "fmc-recipe/0.1", family: "FMC_A_Door_X", template: "Metric Door.rft", ops: [{ op: "add_type", name: "900x2100_Std" }] });
  const live = path.join(root, "A", "FMC_A_Door_X.recipe.json");
  const decoy = path.join(root, "A", "_Evolve", "FMC_A_Door_X", "v002", "FMC_A_Door_X.recipe.json");
  const sidecar = path.join(root, "A", "_Archive", "FMC_A_Door_Old.recipe.json");
  for (const f of [live, decoy, sidecar]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, recipe); }
  const found = stagedRecipes(root).map((s) => s.recipe.family + ":" + path.relative(root, s.rfa).split(path.sep).join("/"));
  assert.deepEqual(found, ["FMC_A_Door_X:A/FMC_A_Door_X.rfa"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("apply refuses without a token, a stale or changed proposal, and an unknown fix id", () => {
  const now = new Date("2026-11-28T10:00:00Z");
  const p = { token: "EV-1", source: "Z:\\a\\F.rfa", source_sha256: "s", created: "2026-11-28T09:00:00Z", fixes: [{ id: "keynote.set", gate: "keynote" as const, summary: "", ops: [] }] };
  assert.match(applyProblems(p, "", "s", undefined, now)[0], /token from check/);
  assert.match(applyProblems(null, "EV-2", "s", undefined, now)[0], /run check again/);
  assert.deepEqual(applyProblems(p, "EV-1", "s", undefined, now), []);
  assert.match(applyProblems(p, "EV-1", "t", undefined, now)[0], /changed since check/);
  assert.match(applyProblems(p, "EV-1", "s", undefined, new Date("2026-11-30T10:00:00Z"))[0], /older than 24 h/);
  assert.match(applyProblems(p, "EV-1", "s", ["naming.rename"], now)[0], /isn't one of the proposal's fixes/);
  assert.match(applyProblems(p, "EV-1", null, undefined, now)[0], /can't be read/);
});

// ---------- fmc_doc ops ----------

test("bind_shared_param is an fmc_doc op, checked against the kit's dictionary", () => {
  assert.equal(OP.safeParse({ op: "bind_shared_param", name: "FMC_Asset_Tag", guid: G_TAG }).success, true);
  assert.equal(OP.safeParse({ op: "bind_shared_param", name: "FMC_Asset_Tag" }).success, false);
  const dict = kit().dictionary!;
  assert.deepEqual(splitProblems(opsProblems([{ op: "bind_shared_param", name: "FMC_Asset_Tag", guid: G_TAG } as any], dict)).errors, []);
  assert.match(splitProblems(opsProblems([{ op: "bind_shared_param", name: "FMC_Asset_Tag", guid: G_FOREIGN } as any], dict)).errors[0], /isn't in FMC_SharedParameters/);
  assert.match(splitProblems(opsProblems([{ op: "bind_shared_param", name: "Other", guid: G_TAG } as any], dict)).errors[0], /names/);
  // a value set after binding isn't an unknown parameter
  const later = opsProblems([{ op: "bind_shared_param", name: "FMC_Asset_Tag", guid: G_TAG } as any, { op: "set_type_value", name: "T/FMC_Asset_Tag", type: "T", param: "FMC_Asset_Tag", value: "x" } as any], dict);
  assert.equal(later.filter((x) => /FMC_Asset_Tag/.test(x) && /isn't made earlier/.test(x)).length, 0);
});

// ---------- the tool, with Revit, the kit and the disk mocked ----------

interface Mock { io: EvolveIo; files: Map<string, string>; calls: Array<Record<string, unknown>>; copies: Array<[string, string]>; replaces: Array<[string, string]>; writes: string[] }

function mock(opts: { source?: string; before?: Partial<EvolveFacts>; flexAfter?: any; applyError?: string; alreadyOpen?: boolean; noSession?: boolean } = {}): Mock {
  const source = opts.source ?? win.join(STAGING, "A", "A_Door_SteelFanlight.rfa");
  const files = new Map<string, string>([[source.toLowerCase(), "ORIGINAL-BYTES"]]);
  const calls: Array<Record<string, unknown>> = [], copies: Array<[string, string]> = [], replaces: Array<[string, string]> = [], writes: string[] = [];
  const key = (p: string) => p.toLowerCase();
  const before = facts({ file: source, family: win.basename(source, ".rfa"), parameters: [{ name: "FMC_Asset_Tag", shared: false, guid: "", instance: true }],
    type_keynotes: [{ type: "900x2100_Std", keynote: "a.dor-01" }, { type: "1000x2100_Std", keynote: "A.DOR_01" }],
    reference_planes: ["Left", "Reference Plane"], reference_planes_detail: [{ name: "Left", axis: "x", at_mm: -450 }, { name: "Reference Plane", axis: "z", at_mm: 2100 }], ...opts.before });
  let saved = "";
  const report = (f: EvolveFacts) => ({ title: f.family, category: f.category, parameters: f.parameters, types: f.types, reference_planes: f.reference_planes, reference_planes_detail: f.reference_planes_detail });
  const afterFacts = (): EvolveFacts => facts({ file: saved });
  let opened = "";
  const io: EvolveIo = {
    config: cfg,
    now: () => new Date("2026-11-28T07:00:00Z"),
    exists: (p) => files.has(key(p)),
    sha256: (p) => files.has(key(p)) ? crypto.createHash("sha256").update(files.get(key(p))!).digest("hex") : null,
    copy: (a, b) => { if (files.has(key(b))) throw new Error("EEXIST " + b); copies.push([a, b]); files.set(key(b), files.get(key(a))!); },
    replace: (a, b) => { replaces.push([a, b]); files.set(key(b), files.get(key(a))!); },
    mkdir: () => {},
    readText: (p) => files.get(key(p)) ?? null,
    writeText: (p, t) => { writes.push(p); files.set(key(p), t); },
    list: (dir) => {
      const out = new Map<string, string[]>();
      for (const k of files.keys()) if (k.startsWith(key(dir) + "\\")) { const rest = k.slice(dir.length + 1).split("\\"); if (rest.length === 2) out.set(rest[0], [...(out.get(rest[0]) ?? []), rest[1]]); }
      return [...out].map(([folder, fs]) => ({ folder, files: fs }));
    },
    kit: () => ({ ...kit(), problems: [] }),
    inspect: async (file) => {
      calls.push({ inspect: file });
      const f = key(file) === key(saved) ? afterFacts() : before;
      return { plan: { family: win.basename(file, ".rfa"), category: f.category, types: f.types, type_keynotes: f.type_keynotes, shared_parameters: f.parameters.filter((p) => p.shared) } };
    },
    doc: async (args) => {
      calls.push(args);
      switch (args.action) {
        case "open": {
          opened = String(args.file);
          if (opts.noSession && key(opened) === key(source)) return { refused: true, reasons: ["isn't in the library roots"] };
          const doc = report(key(opened) === key(saved) ? afterFacts() : before);
          return { session: "s" + calls.length, document: opts.alreadyOpen && key(opened) === key(source) ? { ...doc, already_open: "open in a window" } : doc };
        }
        case "report": return { document: report(before) };
        case "flex": return key(opened) === key(saved) ? { ok: true, types: afterFacts().flex!.types } : (opts.flexAfter && calls.some((c) => c.action === "apply" && c.dry_run === false) ? opts.flexAfter : before.flex);
        case "apply": return opts.applyError && args.dry_run === false ? { error: opts.applyError } : { dry_run: args.dry_run, created: 1, updated: 2, skipped: 0, ops: (args.ops as any[]).map((o) => ({ op: o.op, name: o.name, result: "update" })) };
        case "save": saved = String(args.path); files.set(key(saved), "NEW-VERSION-BYTES"); return { saved: args.path };
        case "close": return { closed: true };
      }
      return {};
    },
    log: () => {},
  };
  return { io, files, calls, copies, replaces, writes };
}

const args = (a: Record<string, unknown>) => z.object(FMC_FAMILY_EVOLVE_SHAPE).parse(a);
const bodyOf = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

test("check is a dry run: Revit's rolled-back apply, a token, the session closed, nothing copied or saved", async () => {
  const m = mock();
  const r = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: win.join(STAGING, "A", "A_Door_SteelFanlight.rfa"), plane_names: [{ axis: "z", at_mm: 2100, name: "Head" }] }), m.io) as any);
  assert.equal(r.dry_run, true);
  assert.match(r.token, /^EV-/);
  assert.deepEqual(r.fixes.map((f: any) => f.id).sort(), ["keynote.set", "naming.rename", "reference_planes.name", "shared_parameters.add", "shared_parameters.bind"]);
  const applies = m.calls.filter((c) => c.action === "apply");
  assert.equal(applies.length, 1);
  assert.equal(applies[0].dry_run, true);
  assert.equal(r.preview.revit_dry_run.updated, 2);
  assert.equal(m.calls.filter((c) => c.action === "save").length, 0);
  assert.equal(m.calls.at(-1)!.action, "close");
  assert.deepEqual(m.copies, []);
  assert.deepEqual(m.replaces, []);
  // the only write is the proposal in the reports folder
  assert.deepEqual(m.writes, [win.join("C:\\FMC_Reports_test", "Evolve", r.token + ".json")]);
  assert.equal(r.versions.new_version, win.join(STAGING, "A", "_Evolve", "A_Door_SteelFanlight", "v002", "FMC_A_Door_SteelFanlight.rfa"));
  assert.equal(r.expected.find((e: any) => e.gate === "shared_parameters").expected, "Pass");
});

test("apply backs up first, works on the backup, saves a new version and leaves the original as it was", async () => {
  const m = mock();
  const src = win.join(STAGING, "A", "A_Door_SteelFanlight.rfa");
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src, plane_names: [{ axis: "z", at_mm: 2100, name: "Head" }] }), m.io) as any);
  const before = m.calls.length;
  const r = bodyOf(await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io) as any);
  assert.equal(r.applied, true, JSON.stringify(r));
  const dir = win.join(STAGING, "A", "_Evolve", "A_Door_SteelFanlight");
  assert.equal(r.backup, win.join(dir, "v001", "A_Door_SteelFanlight.rfa"));
  assert.equal(r.new_version, win.join(dir, "v002", "FMC_A_Door_SteelFanlight.rfa"));
  assert.equal(r.original_unchanged, true);
  assert.equal(r.backup_verified, true);
  assert.equal(m.files.get(src.toLowerCase()), "ORIGINAL-BYTES");
  assert.equal(m.files.get(r.backup.toLowerCase()), "ORIGINAL-BYTES");
  assert.deepEqual(m.copies, [[src, r.backup]]);
  assert.deepEqual(m.replaces, []);
  const applyCalls = m.calls.slice(before);
  // the session opens the backup, never the original
  assert.equal(applyCalls.find((x) => x.action === "open")!.file, r.backup);
  assert.ok(!applyCalls.some((x) => x.action === "open" && String(x.file).toLowerCase() === src.toLowerCase()));
  const real = applyCalls.find((x) => x.action === "apply")!;
  assert.equal(real.dry_run, false);
  assert.equal(applyCalls.find((x) => x.action === "save")!.overwrite, false);
  assert.equal(r.diff.find((d: any) => d.gate === "naming").change, "fixed");
  assert.equal(r.diff.find((d: any) => d.gate === "shared_parameters").change, "fixed");
  assert.ok(m.files.has(r.new_version.toLowerCase().replace(/\.rfa$/, ".evolve.json")));
  // a second apply with the same token makes v003 and reuses the backup
  const again = bodyOf(await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io) as any);
  assert.equal(again.new_version, win.join(dir, "v003", "FMC_A_Door_SteelFanlight.rfa"));
  assert.equal(m.copies.length, 1);
  const v = bodyOf(await runFmcFamilyEvolve(args({ action: "versions", file: src }), m.io) as any);
  assert.deepEqual(v.versions.map((x: any) => [x.version, x.backup]), [["v001", true], ["v002", false], ["v003", false]]);
});

test("apply with accept makes only those fixes and keeps the original's name", async () => {
  const src = win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa");
  const m = mock({ source: src });
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  const before = m.calls.length;
  const r = bodyOf(await runFmcFamilyEvolve(args({ action: "apply", token: c.token, accept: ["keynote.set"] }), m.io) as any);
  assert.equal(r.applied, true);
  assert.equal(r.new_version, win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight", "v002", "FMC_A_Door_SteelFanlight.rfa"));
  const real = m.calls.slice(before).find((x) => x.action === "apply")!;
  assert.deepEqual((real.ops as any[]).map((o) => o.op), ["set_type_value"]);
});

test("apply refuses a changed original before anything is copied", async () => {
  const m = mock();
  const src = win.join(STAGING, "A", "A_Door_SteelFanlight.rfa");
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  m.files.set(src.toLowerCase(), "SOMEONE-SAVED-IT");
  const before = m.calls.length;
  const r = await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io);
  assert.equal(r.isError, true);
  assert.match(bodyOf(r as any).reasons[0], /changed since check/);
  assert.deepEqual(m.copies, []);
  assert.equal(m.calls.length, before);
});

test("a fix that breaks the flex saves nothing and closes the session", async () => {
  const m = mock({ flexAfter: { ok: false, types: [{ type: "900x2100_Std", ok: false, errors: ["Constraints are not satisfied"] }, { type: "1000x2100_Std", ok: true }] } });
  const src = win.join(STAGING, "A", "A_Door_SteelFanlight.rfa");
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  const before = m.calls.length;
  const r = await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io);
  assert.equal(r.isError, true);
  assert.match(bodyOf(r as any).reasons[0], /broke the flex/);
  const after = m.calls.slice(before);
  assert.equal(after.filter((x) => x.action === "save").length, 0);
  assert.equal(after.at(-1)!.action, "close");
  assert.equal(m.files.get(src.toLowerCase()), "ORIGINAL-BYTES");
});

test("a failed Revit apply saves nothing", async () => {
  const m = mock({ applyError: "op 2 failed, nothing was changed: boom" });
  const src = win.join(STAGING, "A", "A_Door_SteelFanlight.rfa");
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  const r = await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io);
  assert.equal(r.isError, true);
  assert.equal(m.calls.filter((x) => x.action === "save").length, 0);
  assert.equal(m.calls.at(-1)!.action, "close");
});

test("replace_original: refused with a new name; done only after the backup is verified", async () => {
  const m0 = mock();
  const c0 = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: win.join(STAGING, "A", "A_Door_SteelFanlight.rfa") }), m0.io) as any);
  const refused = await runFmcFamilyEvolve(args({ action: "apply", token: c0.token, replace_original: true }), m0.io);
  assert.equal(refused.isError, true);
  assert.match(bodyOf(refused as any).reasons.join(" "), /new name/);
  assert.deepEqual(m0.copies, []);
  const src = win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa");
  const m = mock({ source: src });
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  const ok = bodyOf(await runFmcFamilyEvolve(args({ action: "apply", token: c.token, replace_original: true, accept: ["keynote.set", "shared_parameters.bind"] }), m.io) as any);
  assert.equal(ok.applied, true, JSON.stringify(ok));
  assert.equal(ok.replace_original.done, true);
  assert.equal(m.files.get(ok.backup.toLowerCase()), "ORIGINAL-BYTES");
  assert.equal(m.files.get(src.toLowerCase()), "NEW-VERSION-BYTES");
  assert.deepEqual(m.replaces, [[ok.new_version, src]]);
  // the backup was copied before the replace
  assert.equal(m.copies.length, 1);
});

test("replace_original is never for a released family; such a family evolves into staging", async () => {
  const src = win.join(RELEASED, "A_Door_SteelFanlight.rfa");
  const m = mock({ source: src });
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  assert.equal(c.versions.new_version, win.join(STAGING, "A", "_Evolve", "A_Door_SteelFanlight", "v002", "FMC_A_Door_SteelFanlight.rfa"));
  const r = await runFmcFamilyEvolve(args({ action: "apply", token: c.token, replace_original: true }), m.io);
  assert.equal(r.isError, true);
  assert.match(bodyOf(r as any).reasons.join(" "), /only for a file in staging/);
  assert.deepEqual(m.copies, []);
  // without the rename the new version would break the naming rule in staging: refused before any copy
  const unnamed = await runFmcFamilyEvolve(args({ action: "apply", token: c.token, accept: ["keynote.set"] }), m.io);
  assert.equal(unnamed.isError, true);
  assert.match(bodyOf(unnamed as any).reasons[0], /^new version: /);
  assert.deepEqual(m.copies, []);
  const ok = bodyOf(await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io) as any);
  assert.equal(ok.applied, true, JSON.stringify(ok));
  assert.equal(ok.backup, win.join(STAGING, "A", "_Evolve", "A_Door_SteelFanlight", "v001", "A_Door_SteelFanlight.rfa"));
  assert.equal(m.files.get(src.toLowerCase()), "ORIGINAL-BYTES");
});

test("check refuses what isn't a family file and answers no token when nothing can be fixed", async () => {
  const m = mock();
  assert.equal((await runFmcFamilyEvolve(args({ action: "check", file: "Z:\\x\\model.rvt" }), m.io)).isError, true);
  assert.equal((await runFmcFamilyEvolve(args({ action: "check", file: win.join(STAGING, "A", "Missing.rfa") }), m.io)).isError, true);
  const cleanFile = win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa");
  const clean = mock({ source: cleanFile, before: { family: "FMC_A_Door_SteelFanlight", parameters: facts().parameters, type_keynotes: facts().type_keynotes, reference_planes: facts().reference_planes, reference_planes_detail: facts().reference_planes_detail } });
  const r = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: cleanFile }), clean.io) as any);
  assert.deepEqual(r.gates.map((g: any) => g.state), ["Pass", "Pass", "Pass", "Pass", "Pass"]);
  assert.equal(r.token, "");
  assert.deepEqual(clean.writes, []);
});

test("check never runs the ops' dry run on a document the person has open", async () => {
  const m = mock({ alreadyOpen: true });
  const r = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: win.join(STAGING, "A", "A_Door_SteelFanlight.rfa") }), m.io) as any);
  assert.match(r.token, /^EV-/);
  assert.equal(m.calls.filter((c) => c.action === "apply").length, 0);
  assert.ok(r.notes.some((n: string) => /open in a Revit window/.test(n)));
});

test("with no flex from check, a type failing after the fixes stops the apply", async () => {
  const src = win.join(RELEASED, "A_Door_SteelFanlight.rfa");
  const m = mock({ source: src, noSession: true, flexAfter: { ok: false, types: [{ type: "900x2100_Std", ok: false, errors: ["Constraints are not satisfied"] }] } });
  const c = bodyOf(await runFmcFamilyEvolve(args({ action: "check", file: src }), m.io) as any);
  assert.equal(c.gates.find((g: any) => g.gate === "flex").state, "Not checked");
  assert.equal(c.preview, null);
  const r = await runFmcFamilyEvolve(args({ action: "apply", token: c.token }), m.io);
  assert.equal(r.isError, true);
  assert.match(bodyOf(r as any).reasons[0], /no flex from check/);
  assert.equal(m.calls.filter((x) => x.action === "save").length, 0);
});

test("fmc_family_evolve registers as a tool", () => {
  const names: string[] = [];
  registerFmcFamilyEvolveTool({ tool: (n: string) => { names.push(n); } } as any);
  assert.deepEqual(names, ["fmc_family_evolve"]);
});
