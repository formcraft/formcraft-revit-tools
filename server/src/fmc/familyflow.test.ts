/** BSF-3 entry points: fileWriteGate (archive before replace, then claim) and reloadGate (preview first, no default overwrite). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jailRoots } from "./jail.js";
import { FAMILY_LOAD, readFamilyOverwrites, setFamilyOverwriteStatus } from "./familyload.js";
import { fileWriteGate, reloadGate, familyReadGate, type PreviewFn } from "./familyflow.js";
import type { CallJail } from "./jailctx.js";

const win = path.win32;

function world(cfgExtra: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-famflow-"));
  const project = win.join(root, "P-2222");
  const wip = win.join(project, "01_WIP");
  fs.mkdirSync(wip, { recursive: true });
  const model = win.join(wip, "P-2222-ORG-ZZ-00-M3-A-0101.rvt");
  fs.writeFileSync(model, "rvt");
  const kit = win.join(root, "Kit");
  fs.mkdirSync(win.join(kit, "Families"), { recursive: true });
  const cfg = { read_only_roots: [kit], protected_roots: [], ...cfgExtra } as any;
  const j: CallJail = { roots: jailRoots({ title: "A-0101", path: model }, cfg), cfg };
  const store = win.join(root, "approvals", "family_load.json");
  return { root, project, wip, model, kit, cfg, j, store };
}

const blanket = { family_overwrite_blanket: { approved_by: "Emlyn", approved_at: "2026-11-28T12:59:00+03:00" } };

test("FLOW file write: new file passes; existing without overwrite FMC-FAM-EXISTS; dry run writes and queues nothing", () => {
  const w = world();
  const target = win.join(w.wip, "FMC_A_Door.rfa");
  const fresh = fileWriteGate("save_family", target, {}, w.j, { store: w.store });
  assert.equal(fresh.ok, true);
  fs.writeFileSync(target, "v1");
  const no = fileWriteGate("save_family", target, {}, w.j, { store: w.store });
  assert.equal(!no.ok && no.code, FAMILY_LOAD.EXISTS);
  const dry = fileWriteGate("new_family", target, { dry_run: true }, w.j, { store: w.store });
  assert.equal(!dry.ok && dry.code, FAMILY_LOAD.EXISTS);
  assert.equal(readFamilyOverwrites({ store: w.store }).length, 0);
});

test("FLOW file overwrite: waits for a person, then archives (verified) before the replace and claims once", () => {
  const w = world();
  const target = win.join(w.wip, "FMC_A_Door.rfa");
  fs.writeFileSync(target, "v1 bytes");
  const wait = fileWriteGate("export_family", target, { overwrite: true }, w.j, { store: w.store });
  assert.equal(!wait.ok && wait.code, FAMILY_LOAD.WAITING);
  const id = (!wait.ok && wait.approval_id) || "";
  const archive = (!wait.ok && wait.archive) || "";
  assert.equal(fs.existsSync(archive), false, "nothing archived while it waits");
  setFamilyOverwriteStatus(id, "approved", "USER", { store: w.store });
  const go = fileWriteGate("export_family", target, { overwrite: true, approval_id: id }, w.j, { store: w.store });
  assert.equal(go.ok, true);
  assert.equal(go.ok && go.archive_path, archive, "the approval carries the archive path");
  assert.equal(fs.readFileSync(archive, "utf8"), "v1 bytes", "archived before the replace");
  assert.equal(readFamilyOverwrites({ store: w.store }).find((r) => r.id === id)?.status, "used");
  const again = fileWriteGate("export_family", target, { overwrite: true, approval_id: id }, w.j, { store: w.store });
  assert.equal(!again.ok && again.code, FAMILY_LOAD.APPROVAL);
});

test("FLOW file overwrite under the blanket: no click, but the archive and the single-use record stay", () => {
  const w = world(blanket);
  const target = win.join(w.wip, "FMC_A_Door.rfa");
  fs.writeFileSync(target, "v1");
  const go = fileWriteGate("fmc_doc save", target, { overwrite: true }, w.j, { store: w.store });
  assert.equal(go.ok, true);
  assert.ok(go.ok && go.archive_path && fs.existsSync(go.archive_path));
  assert.equal(readFamilyOverwrites({ store: w.store })[0].blanket, true);
});

test("FLOW path escapes: other project, kit, kit staging and a non-family file are refused; the kit may be read", () => {
  const w = world();
  for (const bad of [win.join(w.root, "P-3333", "01_WIP", "x.rfa"), win.join(w.kit, "Families", "x.rfa"), win.join(w.kit, "_Staging", "x.rfa"), win.join(w.wip, "x.txt")]) {
    const r = fileWriteGate("save_family", bad, { overwrite: true }, w.j, { store: w.store });
    assert.equal(r.ok, false, bad);
  }
  fs.writeFileSync(win.join(w.kit, "Families", "FMC_A_Door.rfa"), "kit");
  assert.equal(familyReadGate("load_family", win.join(w.kit, "Families", "FMC_A_Door.rfa"), w.j).ok, true);
  assert.equal(familyReadGate("load_family", win.join(w.root, "Elsewhere", "x.rfa"), w.j).ok, false);
});

test("FLOW reload: preview first; new family loads; existing needs overwrite; approval carries the archive; claimed before Revit", async () => {
  const w = world();
  const none: PreviewFn = async () => ({ exists: false });
  const fresh = await reloadGate("load_family", { family: "FMC_A_Door", source: "x.rfa" }, w.j, none, { store: w.store });
  assert.equal(fresh.ok && !fresh.archive_path, true);
  const there: PreviewFn = async () => ({ exists: true, types: [{ name: "900", instances: 3 }], instances_total: 3 });
  const no = await reloadGate("load_family", { family: "FMC_A_Door", source: "x.rfa" }, w.j, there, { store: w.store });
  assert.equal(!no.ok && no.code, FAMILY_LOAD.EXISTS);
  assert.equal((!no.ok && (no.preview as any))?.instances_total, 3);
  const wait = await reloadGate("load_family", { family: "FMC_A_Door", source: "x.rfa", overwrite: true }, w.j, there, { store: w.store });
  assert.equal(!wait.ok && wait.code, FAMILY_LOAD.WAITING);
  const id = (!wait.ok && wait.approval_id) || "";
  setFamilyOverwriteStatus(id, "approved", "USER", { store: w.store });
  const go = await reloadGate("load_family", { family: "FMC_A_Door", source: "x.rfa", overwrite: true, approval_id: id }, w.j, there, { store: w.store });
  assert.equal(go.ok, true);
  assert.ok(go.ok && /\\_Archive\\Families\\\d{8}-\d{6}_FMC_A_Door\.rfa$/.test(go.archive_path ?? ""));
  assert.equal(readFamilyOverwrites({ store: w.store }).find((r) => r.id === id)?.status, "used");
  // the project changed since the approval (another instance placed): a new approval is needed
  const changed: PreviewFn = async () => ({ exists: true, types: [{ name: "900", instances: 4 }], instances_total: 4 });
  const stale = await reloadGate("load_family", { family: "FMC_A_Door", source: "x.rfa", overwrite: true }, w.j, changed, { store: w.store });
  assert.equal(!stale.ok && stale.code, FAMILY_LOAD.WAITING);
  assert.notEqual(!stale.ok && stale.approval_id, id);
});

test("FLOW reload: a failed preview loads nothing; an unsaved project has nowhere to archive", async () => {
  const w = world();
  const boom: PreviewFn = async () => { throw new Error("Revit busy"); };
  const r = await reloadGate("load_family", { family: "F", overwrite: true }, w.j, boom, { store: w.store });
  assert.equal(!r.ok && r.code, FAMILY_LOAD.PREVIEW);
  const unsaved: CallJail = { roots: jailRoots({ title: "Project1", path: "" }, w.cfg), cfg: w.cfg };
  const there: PreviewFn = async () => ({ exists: true, types: [], instances_total: 0 });
  const u = await reloadGate("load_family", { family: "F", overwrite: true }, unsaved, there, { store: w.store });
  assert.equal(u.ok, false);
});
