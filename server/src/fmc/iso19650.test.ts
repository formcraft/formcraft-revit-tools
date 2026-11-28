import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { IsoFolderInput, TreeReader, applyIsoFolders, forbiddenProjectIn, planIsoFolders, robotIdProblems } from "./iso19650.js";
import { realTreeWriter } from "./centralports.js";

const cfg: GuardConfig = { ...DEFAULT_CONFIG, protected_roots: ["D:\\Fomcraft"] };
const NOW = new Date("2026-11-28T07:00:00Z");

function disk(dirs: Record<string, string[]>): TreeReader {
  const k = (p: string) => p.toLowerCase();
  const map = new Map(Object.entries(dirs).map(([d, l]) => [k(d), l]));
  return { exists: (p) => map.has(k(p)), isDirectory: (p) => map.has(k(p)), list: (p) => map.get(k(p)) ?? [] };
}

const input = (o: Partial<IsoFolderInput> = {}): IsoFolderInput => ({
  project_folder: "Z:\\Projects\\F26009", code: "F26009", name: "Test House", roles: ["A", "S"],
  robots: [{ id: "family-kit-loader-bot", central_create: true }], central_creators: ["emlyn"], created_by: "emlyn", ...o,
});

test("plan: ISO containers, per-role WIP/Shared, admin + info files and robots\\<id>", () => {
  const plan = planIsoFolders(input(), cfg, disk({ "Z:\\Projects": [] }), NOW);
  assert.deepEqual(plan.reasons, []);
  for (const f of ["00_Info", "00_Info\\Admin", "01_WIP", "02_Shared", "03_Published", "04_Archive", "01_WIP\\A", "02_Shared\\S",
    "robots\\family-kit-loader-bot", "robots\\family-kit-loader-bot\\logs"])
    assert.ok(plan.folders.includes("Z:\\Projects\\F26009\\" + f), f);
  const names = plan.files.map((f) => f.path.replace("Z:\\Projects\\F26009\\", ""));
  assert.deepEqual(names.sort(), ["00_Info\\Admin\\FMC_Access.json", "00_Info\\Admin\\FMC_Admin_Log.csv", "00_Info\\FMC_Project_Info.json",
    "00_Info\\README.txt", "robots\\family-kit-loader-bot\\rights.json", "robots\\family-kit-loader-bot\\settings.json"].sort());
  const rights = JSON.parse(plan.files.find((f) => f.path.endsWith("rights.json"))!.content);
  assert.equal(rights.central_create, true);
  assert.deepEqual(rights.write, ["01_WIP\\A", "01_WIP\\S"]);
  const access = JSON.parse(plan.files.find((f) => f.path.endsWith("FMC_Access.json"))!.content);
  assert.deepEqual(access.central_creators, ["emlyn"]);
  assert.deepEqual(access.robots, ["family-kit-loader-bot"]);
  assert.match(plan.tree, /04_Archive\\/);
});

test("plan token is stable across time but changes with the plan", () => {
  const a = planIsoFolders(input(), cfg, disk({ "Z:\\Projects": [] }), NOW);
  const b = planIsoFolders(input(), cfg, disk({ "Z:\\Projects": [] }), new Date("2026-11-28T08:00:00Z"));
  const c = planIsoFolders(input({ roles: ["A"] }), cfg, disk({ "Z:\\Projects": [] }), NOW);
  assert.equal(a.plan_token, b.plan_token);
  assert.notEqual(a.plan_token, c.plan_token);
});

test("existing non-empty folders, protected roots, forbidden projects and CDE gates are refused", () => {
  assert.match(planIsoFolders(input(), cfg, disk({ "Z:\\Projects": ["F26009"], "Z:\\Projects\\F26009": ["model.rvt"] })).reasons.join(), /isn't empty/);
  assert.ok(planIsoFolders(input(), cfg, disk({ "Z:\\Projects": ["F26009"], "Z:\\Projects\\F26009": ["desktop.ini"] })).ok);
  assert.match(planIsoFolders(input({ project_folder: "D:\\Fomcraft\\New" }), cfg, disk({ "D:\\Fomcraft": [] })).reasons.join(), /protected root/);
  assert.match(planIsoFolders(input({ project_folder: "Z:\\Projects\\HEBERT HOSTELS 2" }), cfg, disk({ "Z:\\Projects": [] })).reasons.join(), /HEBERT HOSTELS/);
  assert.match(planIsoFolders(input({ project_folder: "Z:\\Projects\\A-0001" }), cfg, disk({ "Z:\\Projects": [] })).reasons.join(), /A-0001/);
  assert.match(planIsoFolders(input({ project_folder: "Z:\\P\\02_Shared\\X" }), cfg, disk({ "Z:\\P\\02_Shared": [] })).reasons.join(), /CDE gate/);
  assert.match(planIsoFolders(input(), cfg, disk({})).reasons.join(), /parent folder/);
});

test("codes, roles and robot ids are validated", () => {
  const r = planIsoFolders(input({ code: "fmc", roles: ["A", "Q9"], robots: [{ id: "Bad Id" }, { id: "ok-bot" }, { id: "ok-bot", roles: ["M"] }] }),
    cfg, disk({ "Z:\\Projects": [] })).reasons.join(" | ");
  assert.match(r, /Project code/);
  assert.match(r, /Role Q9/);
  assert.match(r, /Robot id "Bad Id"/);
  assert.match(r, /listed twice/);
  assert.match(r, /role M is not one of/);
  assert.deepEqual(robotIdProblems("family-kit-loader-bot"), []);
  assert.equal(forbiddenProjectIn("Z:\\x\\hebert hostels\\y"), "HEBERT HOSTELS");
  assert.equal(forbiddenProjectIn("Z:\\x\\F26009"), null);
});

test("apply (temp folder): builds the tree, never overwrites, refuses a folder that filled up since the plan", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_iso_"));
  try {
    const root = path.join(base, "F26009");
    const plan = planIsoFolders(input({ project_folder: root }), cfg, realTreeWriter, NOW);
    assert.deepEqual(plan.reasons, []);
    const r = applyIsoFolders(plan, realTreeWriter);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.created_files, 6);
    assert.ok(fs.existsSync(path.join(root, "robots", "family-kit-loader-bot", "logs")));
    assert.ok(fs.existsSync(path.join(root, "04_Archive")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "robots", "family-kit-loader-bot", "settings.json"), "utf8")).dry_run_first, true);
    // second run: the folder is no longer empty
    assert.equal(planIsoFolders(input({ project_folder: root }), cfg, realTreeWriter, NOW).ok, false);
    const again = applyIsoFolders(plan, realTreeWriter);
    assert.equal(again.ok, false);
    assert.match(again.error ?? "", /no longer empty/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});


test("KL-T07: empty protected_roots does not refuse a Fomcraft project-tree stand-in", () => {
  const parent = path.win32.join(os.tmpdir(), "fmc_iso_t07", "Fomcraft", "FMC_PROJECTS_27");
  const root = path.win32.join(parent, "Proj");
  const p = planIsoFolders(input({ project_folder: root, code: "PROJ" }), { ...DEFAULT_CONFIG, protected_roots: [] }, disk({ [parent]: [] }));
  assert.equal(p.reasons.filter((r) => /protected root/i.test(r)).length, 0, p.reasons.join(" | "));
  assert.equal(p.ok, true, p.reasons.join(" | "));
});

test("KL-T08: a named originals folder in protected_roots is fail-closed for iso-folders inside it", () => {
  const originals = path.win32.join(os.tmpdir(), "fmc_iso_t08", "named-originals");
  const root = path.win32.join(originals, "New");
  const p = planIsoFolders(input({ project_folder: root, code: "PROJ" }), { ...DEFAULT_CONFIG, protected_roots: [originals] }, disk({ [originals]: [] }));
  assert.match(p.reasons.join(), /protected root/);
  assert.equal(p.ok, false);
});
