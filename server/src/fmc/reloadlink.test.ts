import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER } from "./aiuse.js";
import { writeGuard } from "./opencopy.js";
import { WRITE_COMMANDS } from "./policy.js";
import { classifyLinkLine, judgeReload, planReloadLink } from "./reloadlink.js";
import { runReloadLink } from "../tools/fmc_reload_link.js";

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
  assert.match(handler, /GetLinkDocument/);
  assert.match(handler, /\["link_open"\]/);
  assert.match(handler, /IsFamilyDocument/);
  assert.match(handler, /FmcTarget\.Resolve/);
  assert.match(handler, /FmcVerifySession\.Contains/);
  assert.match(command, /CommandName => "fmc_reload_link"/);
  assert.match(tool, /sendCommand\("fmc_reload_link"/);
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_reload_link"));
});

const centralPath = "D:\\Arch\\HEBERT HOSTELS_central.rvt";
const oldPath = "D:\\Arch\\HEBERT HOSTELS_old.rvt";

test("LinkLoaded with status Unloaded is a failure, and Loaded stays ok", () => {
  const unloaded = judgeReload({
    load_result: "LinkLoaded", status: "Unloaded", path: oldPath, positions_kept: true, link_type_id: 775979,
  }, centralPath);
  assert.equal(unloaded.ok, false);
  assert.equal(unloaded.code, "FMC-LINK-PATH-MISMATCH");
  assert.equal(unloaded.path_matches, false);
  assert.match(unloaded.message ?? "", /still D:\\Arch\\HEBERT HOSTELS_old\.rvt/);
  const stillOut = judgeReload({ load_result: "LinkLoaded", status: "Unloaded", path: centralPath }, centralPath);
  assert.equal(stillOut.ok, false);
  assert.equal(stillOut.code, "FMC-LINK-NOT-LOADED");
  assert.match(stillOut.message ?? "", /still Unloaded/);

  const loaded = judgeReload({ load_result: "LinkLoaded", status: "Loaded", path: centralPath, positions_kept: true }, centralPath);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.code, undefined);
  assert.equal(loaded.path_matches, true);
  assert.equal(loaded.hint, undefined);
});

test("an open local of the same central is named, and a loaded link is not", () => {
  const open = [
    { title: "HEBERT HOSTELS_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt", isWorkshared: true, central: centralPath },
    { title: "FMC_P_PlumbingFixture_ShowerTray_Param", path: "C:\\Fam\\Shower.rfa", isFamily: true, central: centralPath },
    { title: "Already linked", path: centralPath, isLinked: true },
  ];
  const failed = judgeReload({ load_result: "LinkLoaded", status: "Unloaded", path: centralPath }, centralPath, open);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "FMC-LINK-NOT-LOADED");
  assert.match(failed.hint ?? "", /HEBERT HOSTELS_USER/);
  assert.match(failed.message ?? "", /can't load a link to a model open in this session/);
  assert.match(failed.message ?? "", /Close it, or reload from a session where it isn't open/);
  assert.doesNotMatch(failed.hint ?? "", /ShowerTray/);
  assert.doesNotMatch(failed.hint ?? "", /Already linked/);
  assert.equal(failed.path_matches, true);

  const sameFile = judgeReload(
    { load_result: "LinkLoaded", status: "Unloaded", path: centralPath },
    centralPath,
    [{ title: "HEBERT HOSTELS_central", path: centralPath }],
  );
  assert.match(sameFile.hint ?? "", /HEBERT HOSTELS_central/);

  const loaded = judgeReload({ load_result: "LinkLoaded", status: "Loaded", path: centralPath }, centralPath, open);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.hint, undefined);
});

test("Loaded is a lie when the file is open as a host, the path differs, or the link document is null", () => {
  const central = "D:\\Arch\\A-0002.rvt";
  const open = [{ title: "A-0002_USER", path: "C:\\Users\\USER\\A-0002_USER.rvt", isWorkshared: true, central }];
  const host = judgeReload({
    load_result: "LinkOpenAsHost", status: "Loaded", path: "D:\\Arch\\A-0002_old.rvt", link_open: false, link_document: null,
  }, central, open);
  assert.equal(host.ok, false);
  assert.equal(host.code, "FMC-LINK-OPEN-AS-HOST");
  assert.equal(host.status, "NotLoaded");
  assert.equal(host.reported_status, "Loaded");
  assert.equal(host.path_matches, false);
  assert.match(host.hint ?? "", /A-0002_USER/);
  assert.match(host.message ?? "", /geometry is not in the model/);

  const mismatch = judgeReload({ load_result: "LinkLoaded", status: "Loaded", path: "D:\\Arch\\A-0002_old.rvt", link_open: true }, central, open);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "FMC-LINK-PATH-MISMATCH");
  assert.equal(mismatch.status, "NotLoaded");

  const empty = judgeReload({ load_result: "LinkLoaded", status: "Loaded", path: central, link_open: false, link_document: null }, central);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "FMC-LINK-NOT-LOADED");
  assert.match(empty.message ?? "", /GetLinkDocument is null/);
  assert.equal(empty.status, "NotLoaded");

  const real = judgeReload({ load_result: "LinkLoaded", status: "Loaded", path: central, link_open: true, link_document: { title: "A-0002", path: central } }, central);
  assert.equal(real.ok, true);
  assert.equal(real.status, undefined);

  const linked = classifyLinkLine("not linked: LinkOpenAsHost");
  assert.equal(linked.ok, false);
  assert.equal(linked.code, "FMC-LINK-OPEN-AS-HOST");
  assert.equal(classifyLinkLine("linked by shared coordinates, pinned").ok, true);

  const sameCentral = judgeReload({ load_result: "SameCentralModelAsHost", status: "Loaded", path: central, link_open: false, link_document: null }, central, open);
  assert.equal(sameCentral.ok, false);
  assert.equal(sameCentral.code, "FMC-LINK-OPEN-AS-HOST");
  assert.match(sameCentral.hint ?? "", /A-0002_USER/);
  const sameModel = judgeReload({ load_result: "SameModelAsHost", status: "Unloaded", path: central }, central, open);
  assert.equal(sameModel.code, "FMC-LINK-OPEN-AS-HOST");
});

test("the tool reply keeps load_result, status and path, and asks for the open model's central", async () => {
  const asked: string[] = [];
  const ran = await runReloadLink({ document: "HEBERT HOSTELS ELECTRICAL_USER", link_type_id: 775979, path: centralPath, dry_run: false }, {
    documentInfo: async () => ({
      active: { title: "HEBERT HOSTELS ELECTRICAL_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS ELECTRICAL_USER.rvt", isFamily: false },
      documents: [
        { title: "HEBERT HOSTELS ELECTRICAL_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS ELECTRICAL_USER.rvt", isFamily: false, isWorkshared: true, isLinked: false },
        { title: "HEBERT HOSTELS_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt", isFamily: false, isWorkshared: true, isLinked: false },
      ],
    }),
    reload: async () => ({ load_result: "LinkLoaded", status: "Unloaded", path: oldPath, positions_kept: true, link_type_id: 775979 }),
    centralOf: async (document) => {
      asked.push(document);
      return document.includes("HOSTELS_USER.rvt") ? centralPath : "D:\\Arch\\HEBERT HOSTELS ELECTRICAL_central.rvt";
    },
  });
  assert.equal(ran.isError, true);
  const body = JSON.parse(ran.content[0].text) as { ok: boolean; code: string; load_result: string; status: string; path: string; hint: string; path_matches: boolean };
  assert.equal(body.ok, false);
  assert.equal(body.code, "FMC-LINK-PATH-MISMATCH");
  assert.equal(body.load_result, "LinkLoaded");
  assert.equal(body.status, "Unloaded");
  assert.equal(body.path, oldPath);
  assert.equal(body.path_matches, false);
  assert.match(body.hint, /HEBERT HOSTELS_USER/);
  assert.ok(asked.some((name) => name.includes("HEBERT HOSTELS_USER.rvt")));
});

test("RL-1/RL-3/RL-4/RL-5: a dry run reads and names blockers, a moved instance fails, only same-stem documents are asked, a timeout reads the link", async () => {
  const { judgePositions, mayBeTheLink } = await import("./reloadlink.js");
  const info = async () => ({
    active: { title: "E_USER", path: "C:\\W\\E_USER.rvt", isFamily: false },
    documents: [
      { title: "E_USER", path: "C:\\W\\E_USER.rvt", isWorkshared: true },
      { title: "A_USER", path: "C:\\W\\A_USER.rvt", isWorkshared: true },
      { title: "S_USER", path: "C:\\W\\S_USER.rvt", isWorkshared: true },
    ],
  });
  let reloaded = 0;
  const dry = await runReloadLink({ document: "E_USER", link_type_id: 5, path: "D:\\Central\\A.rvt" }, {
    documentInfo: info,
    reload: async () => { reloaded++; return {}; },
    linkFacts: async () => ({ links: [{ type_id: 5, status: "Loaded", path: "D:\\Old\\A.rvt" }, { type_id: 6, status: "Loaded" }] }),
  });
  const body = JSON.parse(dry.content[0].text);
  assert.equal(reloaded, 0);
  assert.equal(body.dry_run, true);
  assert.deepEqual(body.may_block, ["A_USER"]);
  assert.equal(body.current.instances, 1);
  assert.equal(mayBeTheLink({ title: "S_USER" }, "D:\\Central\\A.rvt"), false);

  const moved = judgePositions({ instances: 2, instances_after: 1, positions_kept: false }, { ok: true });
  assert.equal(moved.ok, false);
  assert.equal(moved.code, "FMC-LINK-MOVED");
  assert.equal(judgePositions({ instances: 2, instances_after: 2, positions_kept: true }, { ok: true }).ok, true);

  const timeout = await runReloadLink({ document: "E_USER", link_type_id: 5, dry_run: false }, {
    documentInfo: info,
    reload: async () => { throw new Error("fmc_reload_link timed out"); },
    linkFacts: async () => ({ links: [{ type_id: 5, status: "Loaded", path: "D:\\Old\\A.rvt" }] }),
  });
  const t = JSON.parse(timeout.content[0].text);
  assert.equal(t.timed_out, true);
  assert.match(t.message, /now Loaded at D:/);
});
