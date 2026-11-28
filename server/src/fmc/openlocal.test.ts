import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, WRITE_COMMANDS } from "./policy.js";
import { documentDecision } from "./fairqueue.js";
import { clearRememberedProtected } from "./opencopy.js";
import { FILE_CODES, normaliseWorksets, planCloseLocal, planOpenLocal, type OpenDocRow } from "./openlocal.js";
import { FMC_FILE_SHAPE } from "../tools/fmc_file.js";
import { z } from "zod";

const cfg = { ...DEFAULT_CONFIG, protected_roots: ["D:\\Fomcraft"] };
const local = "C:\\Users\\USER\\Documents\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt";
const exists = (p: string) => p === local;

test("open_local plans an existing workshared local: no detach, no new local, no sync, no save", () => {
  clearRememberedProtected();
  const plan = planOpenLocal({ path: local }, cfg, exists, { exists: true, workshared: true, central: false });
  assert.equal(plan.ok, true);
  assert.equal(plan.activate, true);
  assert.equal(plan.worksets, null);
  assert.equal(plan.workshared, true);
  assert.deepEqual([plan.detach, plan.creates_local, plan.syncs, plan.saves], [false, false, false, false]);
  const bg = planOpenLocal({ path: local, activate: false, worksets: "last" }, cfg, exists, { workshared: true, central: false });
  assert.equal(bg.activate, false);
  assert.equal(bg.worksets, "last_viewed");
  assert.deepEqual(normaliseWorksets(["Shell", " Core "]), ["Shell", "Core"]);
  assert.equal(normaliseWorksets(undefined), null);
});

test("open_local refuses a missing file, a central, a non-project, cloud, protected and live path, with house codes", () => {
  clearRememberedProtected();
  const codes = (input: Parameters<typeof planOpenLocal>[0], probe?: Parameters<typeof planOpenLocal>[3]) => planOpenLocal(input, cfg, exists, probe).codes;
  assert.deepEqual(codes({ path: "" }), [FILE_CODES.PATH_REQUIRED]);
  assert.deepEqual(codes({ path: "C:\\Users\\USER\\Documents\\gone.rvt" }), [FILE_CODES.NOT_FOUND]);
  assert.deepEqual(codes({ path: "C:\\Users\\USER\\Documents\\a.rfa" }), [FILE_CODES.NOT_PROJECT]);
  assert.deepEqual(codes({ path: "BIM 360://project/model.rvt" }), [FILE_CODES.CLOUD_REFUSED]);
  assert.ok(codes({ path: local }, { exists: true, workshared: true, central: true }).includes("FMC-FILE-CENTRAL-REFUSED"));
  const protectedPath = planOpenLocal({ path: "D:\\Fomcraft\\Ogala\\01_WIP\\A\\Ogala-A.rvt" }, cfg, () => true, { workshared: true, central: false });
  assert.deepEqual(protectedPath.codes, [FILE_CODES.PROTECTED_REFUSED]);
  assert.equal(protectedPath.ok, false);
  const livePath = planOpenLocal({ path: local, livePaths: [local] }, cfg, exists);
  assert.deepEqual(livePath.codes, [FILE_CODES.PROTECTED_REFUSED]);
  assert.match(planOpenLocal({ path: local }, cfg, exists, { central: true }).reasons.join(" "), /\[FMC-FILE-CENTRAL-REFUSED\] .*central model/);
});

test("open_local refuses worksets for a file that is not workshared, and an empty workset list", () => {
  clearRememberedProtected();
  const notShared = planOpenLocal({ path: local, worksets: ["Shell"] }, cfg, exists, { exists: true, workshared: false, central: false });
  assert.deepEqual(notShared.codes, [FILE_CODES.NOT_WORKSHARED]);
  // no worksets asked: a file that is not workshared just opens
  assert.equal(planOpenLocal({ path: local }, cfg, exists, { exists: true, workshared: false, central: false }).ok, true);
  assert.deepEqual(planOpenLocal({ path: local, worksets: [] }, cfg, exists).codes, [FILE_CODES.WORKSETS_INVALID]);
  assert.deepEqual(planOpenLocal({ path: local, worksets: ["Shell", " "] }, cfg, exists).codes, [FILE_CODES.WORKSETS_INVALID]);
});

const arch: OpenDocRow = { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: local, isFamily: false, isWorkshared: true, isActive: true, isLocal: true, readOnly: false, isModified: false };
const plumb: OpenDocRow = { title: "F26901-FMC-ZZ-ZZ-M3-P-0001_USER", path: "C:\\Users\\USER\\Documents\\F26901-FMC-ZZ-ZZ-M3-P-0001_USER.rvt", isFamily: false, isWorkshared: true, isActive: false, isLocal: true, readOnly: false };
const copy: OpenDocRow = { title: "Ogala-S.copy", path: "C:\\Users\\USER\\agent-tools\\ogala-R04\\Ogala-S.copy.rvt", isFamily: false, isWorkshared: false, isActive: false, readOnly: true, isDetached: true };
const family: OpenDocRow = { title: "FMC_Socket", path: "C:\\Users\\USER\\agent-tools\\FMC_Socket.rfa", isFamily: true, isWorkshared: false, isActive: false };

test("close_local on an inactive local plans a plain close with no switch", () => {
  const plan = planCloseLocal({ document: plumb.title! }, [arch, plumb], cfg);
  assert.equal(plan.ok, true);
  assert.equal(plan.is_active, false);
  assert.equal(plan.activate_first, "");
  assert.deepEqual([plan.save, plan.syncs, plan.relinquishes], [false, false, false]);
  assert.equal(planCloseLocal({ document: plumb.path! }, [arch, plumb], cfg).title, plumb.title);
});

test("close_local of the active document switches to another open project first, and prefers a real model over a verification copy", () => {
  const plan = planCloseLocal({ document: arch.title! }, [arch, copy, family, plumb], cfg);
  assert.equal(plan.ok, true);
  assert.equal(plan.is_active, true);
  assert.equal(plan.activate_first, plumb.path);
  // only a verification copy left: it is still a valid place to land, but it is the last choice
  assert.equal(planCloseLocal({ document: arch.title! }, [arch, copy], cfg).activate_first, copy.path);
});

test("close_local refuses the only open document, an active document with nowhere to go, families, copies, a central and no name", () => {
  assert.deepEqual(planCloseLocal({ document: arch.title! }, [arch], cfg).codes, [FILE_CODES.ONLY_DOC]);
  const unsaved: OpenDocRow = { title: "Untitled", path: "", isFamily: false, isActive: false };
  assert.deepEqual(planCloseLocal({ document: arch.title! }, [arch, unsaved, family], cfg).codes, [FILE_CODES.ACTIVE_CLOSE]);
  assert.deepEqual(planCloseLocal({ document: family.title! }, [arch, family], cfg).codes, [FILE_CODES.FAMILY_REFUSED]);
  assert.deepEqual(planCloseLocal({ document: copy.title! }, [arch, copy], cfg).codes, [FILE_CODES.VERIFY_COPY]);
  const central: OpenDocRow = { ...plumb, isLocal: false };
  assert.deepEqual(planCloseLocal({ document: central.title! }, [arch, central], cfg).codes, [FILE_CODES.CENTRAL_REFUSED]);
  assert.deepEqual(planCloseLocal({ document: "" }, [arch, plumb], cfg).codes, [FILE_CODES.DOC_REQUIRED]);
  assert.deepEqual(planCloseLocal({ document: "nope" }, [arch, plumb], cfg).codes, [FILE_CODES.DOC_NOT_FOUND]);
  assert.deepEqual(planCloseLocal({ document: "dup" }, [{ ...arch, title: "dup" }, { ...plumb, title: "dup" }], cfg).codes, [FILE_CODES.DOC_AMBIGUOUS]);
});

test("close_local discards unsaved changes only with confirm, and save=true refuses what a tool never saves", () => {
  const dirty: OpenDocRow = { ...plumb, isModified: true };
  assert.deepEqual(planCloseLocal({ document: dirty.title! }, [arch, dirty], cfg).codes, [FILE_CODES.UNSAVED_CHANGES]);
  assert.equal(planCloseLocal({ document: dirty.title!, confirm: true }, [arch, dirty], cfg).ok, true);
  const saved = planCloseLocal({ document: dirty.title!, save: true }, [arch, dirty], cfg);
  assert.equal(saved.ok, true);
  assert.equal(saved.save, true);
  const hebert: OpenDocRow = { title: "HEBERT HOSTELS_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt", isWorkshared: true, isLocal: true };
  assert.deepEqual(planCloseLocal({ document: hebert.title!, save: true }, [arch, hebert], cfg).codes, [FILE_CODES.SAVE_REFUSED]);
  // closing it without saving is fine
  assert.equal(planCloseLocal({ document: hebert.title! }, [arch, hebert], cfg).ok, true);
  const underProtected: OpenDocRow = { ...plumb, path: "D:\\Fomcraft\\Ogala\\P.rvt" };
  assert.deepEqual(planCloseLocal({ document: underProtected.title!, save: true }, [arch, underProtected], cfg).codes, [FILE_CODES.SAVE_REFUSED]);
  assert.match(planCloseLocal({ document: copy.title!, save: true }, [arch, copy], cfg).reasons.join(" "), /verification copy/);
});

test("the fmc_file schema takes open_local and close_local, and only the saving close is a write command", () => {
  const shape = z.object(FMC_FILE_SHAPE);
  const open = shape.parse({ action: "open_local", path: local });
  assert.equal(open.activate, true);
  assert.equal(open.dry_run, true);
  assert.equal(shape.safeParse({ action: "open_local", path: local, worksets: "last_viewed" }).success, true);
  assert.equal(shape.safeParse({ action: "open_local", path: local, worksets: ["Shell"] }).success, true);
  const close = shape.parse({ action: "close_local", document: "x" });
  assert.equal(close.save, false);
  assert.equal(close.dry_run, true);
  assert.equal(WRITE_COMMANDS.has("fmc_close_local_apply"), true);
  assert.equal(WRITE_COMMANDS.has("fmc_close_local"), false);
  assert.equal(WRITE_COMMANDS.has("fmc_open_local"), false);
});

test("fmc_open_local needs no open document, so it works with Revit on the Home page; fmc_close_local names its document", () => {
  assert.equal(documentDecision("fmc_open_local", [], undefined).ok, true);
  assert.equal(documentDecision("fmc_open_local", [{ title: "A", path: "C:\\a.rvt", family: false }, { title: "B", path: "C:\\b.rvt", family: false }], undefined).ok, true);
  const two = [{ title: "A", path: "C:\\a.rvt", family: false }, { title: "B", path: "C:\\b.rvt", family: false }];
  assert.equal(documentDecision("fmc_close_local", two, undefined).ok, false);
  assert.equal(documentDecision("fmc_close_local", two, "B").ok, true);
  assert.equal(documentDecision("fmc_close_local_apply", two, "").ok, false);
});
