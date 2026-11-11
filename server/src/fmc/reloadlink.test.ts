import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER } from "./aiuse.js";
import { writeGuard } from "./opencopy.js";
import { WRITE_COMMANDS } from "./policy.js";
import { planReloadLink } from "./reloadlink.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const project = { title: "F26001-FMC-ZZ-ZZ-M3-A-0001", path: "D:\\Projects\\F26001\\01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", isFamily: false };
const cfg = { protected_roots: ["D:\\Fomcraft\\Live"], copy_roots: ["D:\\Fomcraft\\Copies"], write_roots: ["D:\\Projects\\*\\01_WIP"] };

test("a named project reloads in place, and a path is LoadFrom", () => {
  const reload = planReloadLink({ document: project.title, link_type_id: 442211, path: "  " }, project);
  assert.equal(reload.ok, true);
  if (!reload.ok) return;
  assert.deepEqual(reload.params, { document: project.title, link_type_id: 442211 });
  const from = planReloadLink({ document: project.path, link_type_id: "442211", path: "D:\\Projects\\F26001\\02_Shared\\S\\Structure.rvt" }, project);
  assert.equal(from.ok, true);
  if (!from.ok) return;
  assert.equal(from.params.path, "D:\\Projects\\F26001\\02_Shared\\S\\Structure.rvt");
  assert.equal(from.params.link_type_id, 442211);
});

test("a family, a missing document and a bad link type id are refused before the reload", () => {
  const family = planReloadLink({ document: "Door", link_type_id: 12 }, { title: "Door", path: "C:\\Fam\\Door.rfa", isFamily: true });
  assert.equal(family.ok, false);
  if (family.ok) return;
  assert.match(family.message, /family/i);
  const rfa = planReloadLink({ document: "C:\\Fam\\Door.rfa", link_type_id: 12 }, { title: "Door", path: "C:\\Fam\\Door.rfa", isFamily: false });
  assert.equal(rfa.ok, false);
  const unnamed = planReloadLink({ document: "  ", link_type_id: 12 }, project);
  assert.equal(unnamed.ok, false);
  if (unnamed.ok) return;
  assert.match(unnamed.message, /active document is not used/);
  const bad = planReloadLink({ document: project.title, link_type_id: 1.5 }, project);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.message, /link_type_id/);
  assert.equal(planReloadLink({ document: project.title, link_type_id: 0 }, project).ok, false);
});

test("the reload is a write, so the lease and the original guards apply, and AI does not run it", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_reload_link"));
  assert.equal(NEVER.fmc_reload_link, "links (coordination)");
  const original = { ...project, path: "D:\\Fomcraft\\Live\\A.rvt", isWorkshared: true, isDetached: false, readOnly: false };
  const detached = { ...project, title: "copy", path: "D:\\Fomcraft\\Copies\\A.rvt", isWorkshared: true, isDetached: true, readOnly: true };
  assert.equal(writeGuard(original, "fmc_reload_link", { document: original.path, link_type_id: 12 }, cfg as never).ok, false);
  assert.equal(writeGuard(detached, "fmc_reload_link", { document: detached.path, link_type_id: 12 }, cfg as never).ok, false);
  assert.equal(writeGuard({ ...detached, isLinked: true }, "fmc_reload_link", { link_type_id: 12 }, cfg as never).ok, false);
  const wip = writeGuard({ ...project, isWorkshared: true, isDetached: false, readOnly: false }, "fmc_reload_link", { document: project.path, link_type_id: 12 }, cfg as never);
  assert.equal(wip.ok, true, wip.reasons.join(" | "));
});

test("the add-in handler opens no transaction, and the server sends fmc_reload_link", () => {
  const handler = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcReloadLink.cs"), "utf8");
  const command = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcReloadLinkCommand.cs"), "utf8");
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "fmc_reload_link.ts"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  for (const source of [handler, command]) {
    assert.equal(/new\s+Transaction\s*\(/.test(source), false);
    assert.equal(/new\s+TransactionGroup\s*\(/.test(source), false);
    assert.equal(/new\s+SubTransaction\s*\(/.test(source), false);
  }
  assert.match(handler, /type\.LoadFrom\(ModelPathUtils\.ConvertUserVisiblePathToModelPath\(given\), new WorksetConfiguration\(\)\)/);
  assert.match(handler, /type\.Reload\(\)/);
  assert.match(handler, /GetLinkedFileStatus/);
  assert.match(handler, /IsFamilyDocument/);
  assert.match(handler, /FmcTarget\.Resolve/);
  assert.match(handler, /FmcVerifySession\.Contains/);
  assert.match(command, /CommandName => "fmc_reload_link"/);
  assert.match(tool, /sendCommand\("fmc_reload_link"/);
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_reload_link"));
});
