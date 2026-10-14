import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { FolderReader, ProjectInput, codeProblems, modelName, planProject, projectInfo } from "./project.js";

const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  write_roots: ["Z:\\Projects\\*\\01_WIP"],
  template_roots: ["Z:\\00_Standards\\06_Templates"],
};

function disk(files: Record<string, string[]>, extra: string[] = []): FolderReader {
  const dirs = new Set(Object.keys(files).map((k) => k.toLowerCase()));
  const all = new Set([...extra.map((e) => e.toLowerCase()), ...dirs]);
  return {
    exists: (p) => all.has(p.toLowerCase()),
    isDirectory: (p) => dirs.has(p.toLowerCase()),
    list: (p) => files[Object.keys(files).find((k) => k.toLowerCase() === p.toLowerCase()) ?? ""] ?? [],
  };
}

const A = "Z:\\00_Standards\\06_Templates\\FMC_A_Template_v2.2.rte";
const S = "Z:\\00_Standards\\06_Templates\\FMC_S_Template_v2.2.rte";

const input = (o: Partial<ProjectInput> = {}): ProjectInput => ({
  project_folder: "Z:\\Projects\\F26001", code: "F26001", originator: "FMC", volume: "ZZ", level: "ZZ", type: "M3",
  roles: ["A", "S"], templates: { A, S }, details: { FMC_Project_Name: "Pilot House", FMC_District: "Kampala", FMC_Plot_No: "" },
  stage: "G3", issue_set: "PERMIT", ...o,
});

test("model names follow Manual 4.1", () => {
  assert.equal(modelName("F26001", "FMC", "ZZ", "ZZ", "M3", "A"), "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt");
});

test("project codes: 2-6 A-Z/0-9 and never FMC", () => {
  assert.deepEqual(codeProblems("F26001"), []);
  assert.equal(codeProblems("f26001").length, 1);
  assert.equal(codeProblems("TOOLONG1").length, 1);
  assert.equal(codeProblems("FMC").length, 1);
});

test("an empty folder plans the tree, one model per role in 01_WIP and the manifest", () => {
  const plan = planProject(input(), cfg, disk({ "Z:\\Projects\\F26001": ["desktop.ini"] }, [A, S]));
  assert.deepEqual(plan.reasons, []);
  assert.ok(plan.ok);
  assert.ok(plan.folders.includes("Z:\\Projects\\F26001\\02_Shared"));
  assert.ok(plan.folders.includes("Z:\\Projects\\F26001\\01_WIP\\A\\Families"));
  assert.deepEqual(plan.models.map((m) => m.path), [
    "Z:\\Projects\\F26001\\01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt",
    "Z:\\Projects\\F26001\\01_WIP\\S\\F26001-FMC-ZZ-ZZ-M3-S-0001.rvt",
  ]);
  assert.equal(plan.manifest_path, "Z:\\Projects\\F26001\\01_WIP\\FMC_Project.json");
  assert.deepEqual((plan.manifest as any).details, { FMC_Project_Name: "Pilot House", FMC_District: "Kampala" });
});

test("the folder must exist and be empty (D5)", () => {
  assert.match(planProject(input(), cfg, disk({}, [A, S])).reasons.join(" "), /doesn't exist/);
  assert.match(planProject(input(), cfg, disk({ "Z:\\Projects\\F26001": ["old.rvt"] }, [A, S])).reasons.join(" "), /isn't empty/);
});

test("a folder outside the write roots, bad codes, unknown roles and missing templates are refused", () => {
  const r = planProject(input({ project_folder: "D:\\Elsewhere\\F26001", originator: "F", roles: ["A", "Q9"], templates: { A } }), cfg,
    disk({ "D:\\Elsewhere\\F26001": [] }, [A])).reasons.join(" | ");
  assert.match(r, /Not inside an allowed write folder/);
  assert.match(r, /Originator "F"/);
  assert.match(r, /Role Q9 is not in Manual 4.3/);
  assert.match(r, /No template for role Q9/);
});

test("Project Information takes Revit's fields and the kit's parameters, blanks left out", () => {
  assert.deepEqual(projectInfo(input()), {
    "Project Number": "F26001", "Project Name": "Pilot House", "Project Status": "G3",
    FMC_Project_Name: "Pilot House", FMC_District: "Kampala",
  });
});

test("F-019: the tree comes from the kit's PST-002, roles expanded, later folders stop at their parent", async () => {
  const { treeFolders } = await import("./project.js");
  const kit = ["00_Info", "01_WIP\\<Role>", "02_Shared\\<Role>", "03_Published\\<Stage>", "04_Archive\\<Date>_<Milestone>",
    "05_Incoming\\<Party>\\<Date>", "06_QA\\Health", "06_QA\\Sync", "07_Cost\\QTO"];
  assert.deepEqual(treeFolders(kit, ["A", "S"]), ["00_Info", "01_WIP\\A", "01_WIP\\S", "02_Shared\\A", "02_Shared\\S", "03_Published",
    "04_Archive", "05_Incoming", "06_QA\\Health", "06_QA\\Sync", "07_Cost\\QTO"]);
  const plan = planProject(input(), cfg, disk({ "Z:\\Projects\\F26001": [] }, [A, S]), new Date(), kit);
  assert.ok(plan.folders.includes("Z:\\Projects\\F26001\\06_QA\\Health"));
  assert.equal((plan.manifest as any).tree, "kit rulebook PST-002");
  assert.deepEqual(treeFolders(null, ["A"]), []);
});
