import { test } from "node:test";
import assert from "node:assert/strict";
import { LinkFact, auditLinks, candidates, linkProblems, roleOf } from "./links.js";

const shared = "Z:\\Projects\\F26001\\02_Shared";
const good: LinkFact = { id: 1, name: "F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", path: shared + "\\S\\F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", path_type: "Relative",
  attachment: "Overlay", loaded: true, pinned: true, workset: "Z_Links_S" };

test("role comes from the container name", () => {
  assert.equal(roleOf("F26001-FMC-ZZ-ZZ-M3-M-0001.rvt"), "M");
  assert.equal(roleOf("Consultant model.rvt"), "");
});

test("the audit lists what breaks the Manual, link by link", () => {
  const bad: LinkFact = { ...good, id: 2, name: "F26001-FMC-ZZ-ZZ-M3-M-0001.rvt", path: "C:\\Temp\\F26001-FMC-ZZ-ZZ-M3-M-0001.rvt", path_type: "Absolute",
    attachment: "Attachment", pinned: false, workset: "Workset1" };
  const a = auditLinks([good, bad], true, ["Z_Links_S"]);
  assert.equal(a[0].state, "OK");
  assert.deepEqual(a[1].problems, ["not pinned", "not from 02_Shared", "absolute path", "attachment (use overlay)", "workset Z_Links_M missing"]);
  assert.deepEqual(auditLinks([{ ...good, workset: "" }], false, []).map((x) => x.state), ["OK"]);
});

test("candidates skip backups, mark linked models and the model itself", () => {
  const files = [shared + "\\S\\F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", shared + "\\S\\F26001-FMC-ZZ-ZZ-M3-S-0001.0003.rvt",
    shared + "\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", shared + "\\M\\F26001-FMC-ZZ-ZZ-M3-M-0001.rvt"];
  const c = candidates(files, [good], "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt");
  assert.deepEqual(c.map((x) => `${x.role} ${x.linked} ${x.own}`), ["A false true", "M false false", "S true false"]);
});

test("links come from 02_Shared only, never the model itself", () => {
  assert.deepEqual(linkProblems(shared + "\\M\\F26001-FMC-ZZ-ZZ-M3-M-0001.rvt", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt"), []);
  assert.match(linkProblems("Z:\\Projects\\F26001\\01_WIP\\M\\x.rvt", "a.rvt")[0], /02_Shared only/);
  assert.match(linkProblems(shared + "\\A\\a.rvt", "a.rvt")[0], /can't link itself/);
});
