import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectSaveVerdict } from "./saveproject.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

const project = { title: "P-F-V-00-M3-A-0001", path: "C:\\Jobs\\P\\01_WIP\\P-F-V-00-M3-A-0001.rvt", isFamily: false };

test("fmc_save_project requires the open title and path and refuses a family", () => {
  assert.equal(projectSaveVerdict(project, project).ok, true);
  assert.equal(projectSaveVerdict({ ...project, path: "c:/Jobs/P/01_WIP/P-F-V-00-M3-A-0001.rvt" }, project).ok, true);
  const title = projectSaveVerdict({ ...project, title: "Other" }, project);
  assert.equal(title.ok, false);
  if (!title.ok) assert.match(title.message, /Open title is/);
  const wrong = projectSaveVerdict({ ...project, path: "D:\\Other.rvt" }, project);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.match(wrong.message, /Open path is/);
  const family = projectSaveVerdict(project, { ...project, isFamily: true, path: "C:\\Fam\\FMC_A_Door.rfa" });
  assert.equal(family.ok, false);
  if (!family.ok) assert.match(family.message, /family document/);
  const rfa = projectSaveVerdict({ title: "Door", path: "C:\\Fam\\Door.rfa" }, { title: "Door", path: "C:\\Fam\\Door.rfa", isFamily: false });
  assert.equal(rfa.ok, false);
  if (!rfa.ok) assert.match(rfa.message, /\.rfa/);
  const closed = projectSaveVerdict(project, null);
  assert.equal(closed.ok, false);
});

test("the safe save uses the existing read and the existing write, so the lock and the lease still apply", () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "fmc_save_project.ts"), "utf8");
  const read = /sendCommand\(\s*"([a-z_]+)"/g;
  const names = [...src.matchAll(read)].map((m) => m[1]);
  assert.deepEqual(names, ["fmc_document_info", "fmc_revit_file"]);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_document_info"));
  assert.ok(WRITE_COMMANDS.has("fmc_revit_file"));
  assert.match(src, /action: "save"/);
  assert.match(src, /THE safe project save/);
});
