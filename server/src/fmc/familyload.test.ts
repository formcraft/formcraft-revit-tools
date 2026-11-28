/** BSF-3 safe family load / reload / overwrite: no default overwrite, preview, archive before replace, path escapes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jailRoots } from "./jail.js";
import {
  FAMILY_LOAD, archiveFile, archiveFolderFor, claimFamilyOverwrite, familyBlanket, fileFingerprint, readFamilyOverwrites,
  familyPathGate, reloadFingerprint, requireFamilyOverwrite, setFamilyOverwriteStatus, type OverwriteAsk,
} from "./familyload.js";

const win = path.win32;

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-famload-"));
  const project = win.join(root, "P-1234");
  const wip = win.join(project, "01_WIP", "A");
  fs.mkdirSync(wip, { recursive: true });
  const model = win.join(wip, "P-1234-ORG-ZZ-00-M3-A-0101.rvt");
  fs.writeFileSync(model, "rvt");
  const kit = win.join(root, "Kit");
  fs.mkdirSync(win.join(kit, "_Staging"), { recursive: true });
  fs.mkdirSync(win.join(kit, "Families"), { recursive: true });
  const other = win.join(root, "P-9999", "01_WIP");
  fs.mkdirSync(other, { recursive: true });
  const store = win.join(root, "approvals", "family_load.json");
  const cfg = { read_only_roots: [kit], protected_roots: [] } as any;
  const roots = jailRoots({ title: "A-0101", path: model }, cfg);
  return { root, project, wip, model, kit, other, store, cfg, roots };
}

const ask = (w: ReturnType<typeof world>, over: Partial<OverwriteAsk> = {}): OverwriteAsk => ({
  op: "load_family", overwrite: "reload", family: "FMC_A_Door", project: w.model, target: `${w.model}#FMC_A_Door`,
  fingerprint: reloadFingerprint({ types: [{ name: "900", instances: 4 }], instances_total: 4 }, "x.rfa"),
  archiveFolder: archiveFolderFor(w.model, w.roots, w.cfg), wantOverwrite: true, cfg: w.cfg, roots: w.roots, ...over,
});

test("FAM no default overwrite: an existing family without overwrite:true is refused with FMC-FAM-EXISTS and the preview", () => {
  const w = world();
  const preview = { exists: true, types: [{ name: "900", instances: 4 }], instances_total: 4 };
  const r = requireFamilyOverwrite(ask(w, { wantOverwrite: false, preview }), true, { store: w.store });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, FAMILY_LOAD.EXISTS);
  assert.deepEqual(!r.ok && r.preview, preview);
  assert.equal(readFamilyOverwrites({ store: w.store }).length, 0, "a refusal queues nothing");
  // nothing there: no approval, no archive
  assert.deepEqual(requireFamilyOverwrite(ask(w), false, { store: w.store }), { ok: true, overwrite: false });
});

test("FAM preview: the waiting answer carries the preview, the approval id and the archive path inside the project", () => {
  const w = world();
  const preview = { exists: true, types: [{ name: "900", instances: 4 }, { name: "1000", instances: 0 }], instances_total: 4, type_changes: { added: ["1200"], removed: ["1000"] } };
  const r = requireFamilyOverwrite(ask(w, { preview }), true, { store: w.store });
  assert.equal(!r.ok && r.code, FAMILY_LOAD.WAITING);
  assert.deepEqual(!r.ok && r.preview, preview);
  const archive = (!r.ok && r.archive) || "";
  assert.ok(archive.toLowerCase().startsWith(win.join(w.project, "_Archive", "Families").toLowerCase()), archive);
  assert.match(archive, /\\\d{8}-\d{6}_FMC_A_Door\.rfa$/);
  // the same overwrite asked again: the same record
  const again = requireFamilyOverwrite(ask(w, { preview }), true, { store: w.store });
  assert.equal(!again.ok && again.approval_id, !r.ok && r.approval_id);
  assert.equal(readFamilyOverwrites({ store: w.store }).length, 1);
});

test("FAM one approval per overwrite: a person approves, it is used once; testing auto_approve does not approve", () => {
  const w = world();
  const cfg = { ...w.cfg, ai_modeller: { mode: "testing", auto_approve: true } };
  const first = requireFamilyOverwrite(ask(w, { cfg }), true, { store: w.store });
  assert.equal(!first.ok && first.code, FAMILY_LOAD.WAITING, "testing auto_approve never approves a family overwrite");
  const id = (!first.ok && first.approval_id) || "";
  assert.throws(() => setFamilyOverwriteStatus(id, "approved", "", { store: w.store }), /person/);
  setFamilyOverwriteStatus(id, "approved", "USER", { store: w.store });
  const ok = requireFamilyOverwrite(ask(w, { approvalId: id }), true, { store: w.store });
  assert.equal(ok.ok && ok.overwrite, true);
  claimFamilyOverwrite(id, { store: w.store });
  const used = requireFamilyOverwrite(ask(w, { approvalId: id }), true, { store: w.store });
  assert.equal(!used.ok && used.code, FAMILY_LOAD.APPROVAL);
  assert.throws(() => claimFamilyOverwrite(id, { store: w.store }), /not approved/);
  // another family's overwrite can't use it
  const other = requireFamilyOverwrite(ask(w, { approvalId: id, family: "X", target: `${w.model}#X` }), true, { store: w.store });
  assert.equal(!other.ok && other.code, FAMILY_LOAD.APPROVAL);
});

test("FAM blanket approval (a person's, in fmc_guard.json) removes the click only: the record and the archive stay", () => {
  const w = world();
  assert.equal(familyBlanket({ family_overwrite_blanket: { approved_by: "auto", approved_at: "x" } } as any), null);
  const cfg = { ...w.cfg, family_overwrite_blanket: { approved_by: "Emlyn", approved_at: "2026-11-28T12:59:00+03:00" } };
  const r = requireFamilyOverwrite(ask(w, { cfg }), true, { store: w.store });
  assert.equal(r.ok && r.overwrite, true);
  const rec = r.ok && r.overwrite ? r.record : null;
  assert.equal(rec?.blanket, true);
  assert.match(rec?.approved_by ?? "", /blanket: Emlyn/);
  assert.ok(rec?.archive.includes("_Archive"));
  claimFamilyOverwrite(rec!.id, { store: w.store });
  // single use even under the blanket: the next overwrite is a new record
  const next = requireFamilyOverwrite(ask(w, { cfg, fingerprint: "rl-other" }), true, { store: w.store });
  assert.notEqual(next.ok && next.overwrite ? next.record.id : "", rec!.id);
});

test("FAM archive created before replace: the copy is verified, the original untouched; a changed file is refused", () => {
  const w = world();
  const target = win.join(w.wip, "Families", "FMC_A_Door.rfa");
  fs.mkdirSync(win.dirname(target), { recursive: true });
  fs.writeFileSync(target, "old family bytes");
  const sha = fileFingerprint(target);
  const archive = win.join(w.project, "_Archive", "Families", "20261128-140000_FMC_A_Door.rfa");
  const a = archiveFile(target, archive, sha);
  assert.equal(a.ok, true);
  assert.equal(fs.readFileSync(archive, "utf8"), "old family bytes");
  assert.equal(fs.readFileSync(target, "utf8"), "old family bytes");
  assert.equal(fs.existsSync(archive + ".partial"), false);
  // never over an existing archive, and never when the file changed since the approval
  assert.equal(archiveFile(target, archive, sha).ok, false);
  fs.writeFileSync(target, "changed");
  const b = archiveFile(target, archive.replace("140000", "140001"), sha);
  assert.equal(b.ok, false);
  assert.match(!b.ok ? b.reason : "", /changed since the approval/);
});

test("FAM file overwrite through the gate: archive path inside the jail, then the record is claimed", () => {
  const w = world();
  const target = win.join(w.wip, "FMC_A_Window.rfa");
  fs.writeFileSync(target, "v1");
  const cfg = { ...w.cfg, family_overwrite_blanket: { approved_by: "Emlyn", approved_at: "2026-11-28T12:59:00+03:00" } };
  const g = requireFamilyOverwrite({ op: "save_family", overwrite: "file", family: "FMC_A_Window", project: w.model, target,
    fingerprint: fileFingerprint(target), archiveFolder: archiveFolderFor(w.model, w.roots, cfg), wantOverwrite: true, cfg, roots: w.roots }, true, { store: w.store });
  assert.equal(g.ok && g.overwrite, true);
  if (!(g.ok && g.overwrite)) return;
  assert.equal(archiveFile(target, g.archive, g.record.fingerprint).ok, true);
  assert.equal(fs.existsSync(g.archive), true, "the archive exists before the replace");
  claimFamilyOverwrite(g.record.id, { store: w.store });
});

test("FAM path escapes: other project, kit, kit staging (switch off), traversal, shared state, unsaved project", () => {
  const w = world();
  const ok = familyPathGate("save_family", "write", win.join(w.wip, "FMC_A_Door.rfa"), w.roots, w.cfg);
  assert.equal(ok.ok, true);
  for (const bad of [
    win.join(w.other, "FMC_A_Door.rfa"),
    win.join(w.kit, "Families", "FMC_A_Door.rfa"),
    win.join(w.wip, "..", "..", "..", "P-9999", "01_WIP", "x.rfa"),
    win.join(w.project + "2", "01_WIP", "x.rfa"),
    win.join(process.env.LOCALAPPDATA || "C:\\Users\\Default\\AppData\\Local", "Formcraft", "x.rfa"),
  ]) assert.equal(familyPathGate("save_family", "write", bad, w.roots, w.cfg).ok, false, bad);
  const staging = familyPathGate("save_family", "write", win.join(w.kit, "_Staging", "FMC_A_Door.rfa"), w.roots, w.cfg);
  assert.equal(staging.ok, false);
  assert.match(!staging.ok ? staging.message : "", /kit_staging_writes/);
  // the kit may be read (a family loaded from the kit)
  fs.writeFileSync(win.join(w.kit, "Families", "FMC_A_Door.rfa"), "kit");
  assert.equal(familyPathGate("load_family", "read", win.join(w.kit, "Families", "FMC_A_Door.rfa"), w.roots, w.cfg).ok, true);
  // an unsaved project has no folder: every family write is refused
  const unsaved = jailRoots({ title: "Project1", path: "" }, w.cfg);
  assert.equal(familyPathGate("new_family", "write", win.join(w.wip, "x.rfa"), unsaved, w.cfg).ok, false);
  assert.equal(archiveFolderFor("", unsaved, w.cfg), "");
});

test("FAM no archive folder in the jail: an overwrite is refused (FMC-FAM-ARCHIVE), nothing queued", () => {
  const w = world();
  const r = requireFamilyOverwrite(ask(w, { archiveFolder: win.join(w.kit, "_Archive") }), true, { store: w.store });
  assert.equal(!r.ok && r.code, FAMILY_LOAD.ARCHIVE);
  assert.equal(readFamilyOverwrites({ store: w.store }).length, 0);
});

test("FAM pane: only the pane CLI approves, with the Windows user; list shows pending records", async () => {
  const { paneFamilyLoad } = await import("./familyload_pane.js");
  const w = world();
  const r = requireFamilyOverwrite(ask(w), true, { store: w.store });
  const id = (!r.ok && r.approval_id) || "";
  assert.equal((paneFamilyLoad("family_load_list", {}, "USER", { store: w.store }).records as unknown[]).length, 1);
  assert.match(String(paneFamilyLoad("family_load_approve", { id }, "", { store: w.store }).error), /person/);
  assert.equal(paneFamilyLoad("family_load_approve", { id }, "USER", { store: w.store }).status, "approved");
  assert.match(String(paneFamilyLoad("family_load_reject", { id }, "USER", { store: w.store }).error), /approved/);
});
