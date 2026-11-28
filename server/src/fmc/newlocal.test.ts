import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFmcNewLocal, documentInfoKey } from "../tools/fmc_new_local.js";
import { DEFAULT_CONFIG, GuardConfig, WRITE_COMMANDS } from "./policy.js";
import { AiModellerConfig, COMMAND_GROUPS, NEVER, aiVerdict, parseRulebook } from "./aiuse.js";
import { writeGuard } from "./opencopy.js";
import { documentRequired } from "./fairqueue.js";
import { explain } from "./explain.js";
import {
  CentralFile, MoveFs, NewLocalInput, NewLocalPlan, OpenDoc, PlanContext, moveBackup, newLocalProbeScript, newLocalScript, planNewLocal, restoreBackup, runNewLocalSteps, scriptLiteralProblem, wireNewLocal,
} from "./newlocal.js";

const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  protected_roots: ["D:\\Fomcraft"],
  blocked_segments: ["02_Shared", "03_Published", "04_Archive", "05_Incoming"],
  write_roots: ["C:\\WIP", "D:\\Projects\\*\\01_WIP"],
};
const central = "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001_central.rvt";
const local = "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt";
const now = new Date(2026, 10, 18);

const centralFile: CentralFile = { exists: true, isWorkshared: true, isCentral: true, centralPath: central };

function doc(partial: Partial<OpenDoc> & Pick<OpenDoc, "title" | "path">): OpenDoc {
  return { isFamily: false, isWorkshared: true, isActive: false, isDetached: false, centralPath: central, ...partial };
}

function input(partial: Partial<NewLocalInput> = {}): NewLocalInput {
  return { document: "Architecture", central, local, dry_run: true, ...partial };
}

function ctx(partial: Partial<PlanContext> = {}): PlanContext {
  const architecture = doc({ title: "Architecture", path: local, isActive: false, modified: false, ownedWorksets: 0 });
  const sketch = doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "", isActive: true });
  return {
    cfg, now, exists: (p) => p.toLowerCase() === central.toLowerCase(),
    docs: [architecture, sketch],
    centralFile,
    holder: { lease: "mine", client: "stdio" },
    caller: { client: "stdio", lease: "mine" },
    queueRunning: null,
    ...partial,
  };
}

test("refuses a central that is the local, a non-central, a protected path, and a missing document", () => {
  const same = planNewLocal(input({ local: central }), ctx());
  assert.match(same.reasons.join(" "), /same file/);
  assert.equal(same.script, undefined);

  const notCentral = planNewLocal(input(), ctx({ centralFile: { exists: true, isWorkshared: true, isCentral: false, centralPath: "C:\\Other\\model.rvt" } }));
  assert.match(notCentral.reasons.join(" "), /not a central/);

  const worksharedOnly = planNewLocal(input(), ctx({ centralFile: { exists: true, isWorkshared: false, isCentral: false, centralPath: "" } }));
  assert.match(worksharedOnly.reasons.join(" "), /not a central/);

  const protectedLocal = planNewLocal(input({ local: "D:\\Fomcraft\\Live\\A.rvt", document: "Live" }), ctx({
    docs: [doc({ title: "Live", path: "D:\\Fomcraft\\Live\\A.rvt", isActive: false }), doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "" })],
  }));
  assert.match(protectedLocal.reasons.join(" "), /Protected original/);

  const blocked = planNewLocal(input({ local: "C:\\Jobs\\02_Shared\\A.rvt", document: "Shared" }), ctx({
    docs: [doc({ title: "Shared", path: "C:\\Jobs\\02_Shared\\A.rvt" }), doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "" })],
  }));
  assert.match(blocked.reasons.join(" "), /02_shared/i);

  const missing = planNewLocal(input({ document: "Plumbing", central: "C:\\missing\\central.rvt", local: "C:\\missing\\local.rvt" }), ctx({
    exists: () => false,
    centralFile: { exists: false, isWorkshared: false, isCentral: false, centralPath: "" },
  }));
  assert.match(missing.reasons.join(" "), /No open document is called "Plumbing"/);
  assert.equal(missing.resume, false);
  assert.equal(missing.closes, false);
});

test("an active document switches to another open project, and a dry run only reports the plan", () => {
  const active = planNewLocal(input(), ctx({
    docs: [
      doc({ title: "Architecture", path: local, isActive: true }),
      doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "", isActive: false }),
    ],
  }));
  assert.equal(active.ok, true, active.reasons.join(" | "));
  assert.equal(active.active, true);
  assert.equal(active.switch_to, "Sketch");
  assert.equal(active.switch_path, "C:\\WIP\\Sketch.rvt");
  assert.equal(active.script_document, "Sketch");
  assert.equal(active.dry_run, true);
  assert.equal(active.closes, false);
  assert.equal(active.backup, "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt.bak-20261118");
  assert.equal(active.calls[0].params.action, "open");
  assert.equal(active.calls[0].params.path, "C:\\WIP\\Sketch.rvt");
  assert.equal(active.calls[0].params.document, "Sketch");
  assert.equal(active.calls[1].params.action, "close");
  assert.equal(active.calls[1].params.title, "Architecture");
  assert.equal(active.calls[1].params.save, false);
  assert.equal(active.calls[1].params.document, "Sketch");
  assert.equal(active.calls[2].command, "fmc_new_local");
  assert.equal(active.calls[2].params.document, "Sketch");
  assert.equal(active.calls[2].params._lock_document, "C:\\WIP\\Sketch.rvt");
  assert.equal(active.calls[0].params._lock_document, local);
  assert.equal(active.calls[1].params._lock_document, local);
  assert.equal(active.calls[3].params.action, "open");
  assert.equal(active.calls[3].params.path, local);
  assert.equal(active.calls[3].params.document, "Sketch");
  assert.equal(active.calls[3].params._lease_document, "Architecture");
  assert.equal(active.calls[3].params._lock_document, local);
  assert.match(active.steps.join("\n"), /fmc_revit_file \{action:"open", path:/);
  assert.match(active.steps.join("\n"), /fmc_revit_file \{action:"close", title:"Architecture", save:false\}/);
  assert.match(active.steps.join("\n"), /CreateNewLocal/);
  assert.match(active.steps.join("\n"), /OpenAllWorksets/);

  const named = planNewLocal(input({ switch_to: "Other" }), ctx({
    docs: [
      doc({ title: "Architecture", path: local, isActive: true }),
      doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "", isActive: false }),
      doc({ title: "Other", path: "C:\\WIP\\Other.rvt", isWorkshared: false, centralPath: "", isActive: false }),
    ],
  }));
  assert.equal(named.switch_to, "Other");

  const idle = planNewLocal(input({ dry_run: false }), ctx());
  assert.equal(idle.ok, true, idle.reasons.join(" | "));
  assert.equal(idle.closes, true);
  assert.equal(idle.calls[0].params.action, "open");
  assert.equal(idle.calls[0].params.path, "C:\\WIP\\Sketch.rvt");
  assert.equal(idle.calls[0].params.document, "Sketch");
  assert.equal(wireNewLocal({ code: idle.script, _script_document: idle.script_document }).params.document, "Sketch");

  const familyFirst = planNewLocal(input(), ctx({
    docs: [
      doc({ title: "Architecture", path: local }),
      doc({ title: "Door", path: "C:\\WIP\\Door.rfa", isFamily: true, isWorkshared: false, centralPath: "" }),
      doc({ title: "Linked", path: "C:\\WIP\\Linked.rvt", isLinked: true, isWorkshared: false, centralPath: "" }),
      doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "" }),
    ],
  }));
  assert.equal(familyFirst.switch_to, "Sketch");
  assert.equal(familyFirst.switch_path, "C:\\WIP\\Sketch.rvt");
});

test("a backup that already exists takes the next free name, and another caller's lease or batch is refused", () => {
  const taken = "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt.bak-20261118";
  const plan = planNewLocal(input(), ctx({
    exists: (p) => p.toLowerCase() === central.toLowerCase() || p.toLowerCase() === taken.toLowerCase(),
  }));
  assert.equal(plan.backup, "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt.bak-20261118-2");

  const folder = planNewLocal(input(), ctx({
    exists: (p) => p.toLowerCase() === central.toLowerCase() || p.toLowerCase() === "c:\\wip\\f26001-fmc-zz-zz-m3-a-0001_backup",
  }));
  assert.equal(folder.backup_folder_from, "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001_backup");
  assert.match(folder.backup_folder_to, /\.bak-20261118$/);

  const leased = planNewLocal(input(), ctx({ holder: { lease: "other", client: "bob" }, caller: { client: "stdio", lease: "mine" } }));
  assert.match(leased.reasons.join(" "), /Another lease holds/);

  const ours = planNewLocal(input(), ctx({ holder: { lease: "mine", client: "stdio" }, caller: { client: "stdio", lease: "mine" } }));
  assert.equal(ours.ok, true, ours.reasons.join(" | "));

  const running = planNewLocal(input(), ctx({ queueRunning: { client: "bob", label: local }, caller: { client: "stdio" } }));
  assert.match(running.reasons.join(" "), /running a batch/);
});

test("quotes and newlines are rejected and are not written into the script", () => {
  for (const bad of [
    input({ local: 'C:\\WIP\\A".rvt' }),
    input({ central: "C:\\WIP\\central\n.rvt" }),
    input({ document: "Arch\"itecture" }),
    input({ switch_to: "Sketch\r\nX" }),
    input({ backup_suffix: ".bak\"x" }),
  ]) {
    const plan = planNewLocal(bad, ctx());
    assert.match(plan.reasons.join(" "), /quote or a newline/, JSON.stringify(bad));
    assert.equal(plan.script, undefined);
  }
  assert.match(scriptLiteralProblem("ok\n", "document") ?? "", /quote or a newline/);
  assert.throws(() => newLocalScript({ central, local: 'C:\\WIP\\A".rvt' }), /quote or a newline/);

  const good = planNewLocal(input(), ctx());
  assert.equal(good.ok, true, good.reasons.join(" | "));
  const script = good.script ?? "";
  assert.match(script, /WorksharingUtils\.CreateNewLocal/);
  assert.match(script, /OpenDocumentFile/);
  assert.match(script, /WorksetConfigurationOption\.OpenAllWorksets/);
  assert.doesNotMatch(script, /OpenAndActivateDocument/);
  assert.doesNotMatch(script, /Close\(false\)/);
  assert.doesNotMatch(script, /new Transaction/);
  assert.match(script, /@"C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001_central\.rvt"/);
  assert.equal(script.includes('A".rvt'), false);
  assert.equal(script.includes("\nreturn 1;"), false);
});

test("the command is a write in its own group, admin-only unless access is full, and the guard requires document", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_new_local"));
  assert.equal(COMMAND_GROUPS.fmc_new_local, "files (new local)");
  assert.equal(NEVER.fmc_new_local, "files (new local)");
  assert.match(documentRequired("fmc_new_local", ["Only"], undefined) ?? "", /fmc_new_local needs document/);
  assert.match(documentRequired("fmc_new_local", ["A", "B"], undefined) ?? "", /fmc_new_local needs document/);
  assert.equal(documentRequired("fmc_new_local", ["Only"], "Only"), undefined);

  const book = { schema: "fmc-aiuse/0.1", default_involvement: 20, bands: [{ min: 0, max: 100, name: "all", groups: ["views"] }],
    groups: { views: { name: "Views", auto_allowed: true } }, discipline_overrides: {}, limits: { batch_elements: 50, daily_elements: 200, failed_batches_per_day: 3 },
    cap: { measure: "none" }, general: { level: "Fix with approval" as const, groups: ["views"] } };
  const model = { title: "F26001-FMC-ZZ-ZZ-M3-A-0001", path: "D:\\Projects\\F26001\\01_WIP\\A\\M.rvt", isFamily: false, isWorkshared: true, isLocal: true };
  const state = { day: "", models: {} };
  const general = aiVerdict({ command: "fmc_new_local", doc: model, elements: 1, approved: true }, cfg, book, { on: true, stop: false, access: "general", projects: { F26001: { general: true } }, levels: {} }, state);
  assert.match(general.reasons[0], /AI never runs fmc_new_local/);
  const full = aiVerdict({ command: "fmc_new_local", doc: model, elements: 1, approved: false }, cfg, book, { on: false, stop: false, access: "full", mode: "strict", projects: { F26001: { general: true } }, levels: {} }, state);
  assert.equal(full.needs_approval, true);
  const testing = aiVerdict({ command: "fmc_new_local", doc: model, elements: 1, approved: true }, cfg, book, { on: false, stop: false, access: "full", mode: "testing", auto_approve: true, projects: { F26001: { general: true } }, levels: {} }, state);
  assert.equal(testing.ok, true, testing.reasons.join(" | "));
  assert.match(explain("fmc_new_local", { document: "Architecture", central, local, dry_run: true }).join(" "), /DRY RUN/);
  assert.match(explain("fmc_new_local", { document: "Architecture", central, local, dry_run: true }).join(" "), /fmc_revit_file/);
});

const made = {
  success: true,
  result: JSON.stringify({
    ok: true, title: "Architecture", path: local, isWorkshared: true, isLocal: true, central, worksets: 4, opened_how: "background",
  }),
};

function harness(failAt?: "switch" | "close" | "activate") {
  const sent: Array<{ command: string; params: Record<string, unknown> }> = [];
  let copied: NewLocalPlan | undefined;
  const sendCommand = async (command: string, params: Record<string, unknown>) => {
    sent.push({ command, params });
    if (failAt === "switch" && sent.length === 1) throw new Error("An internal error has occurred");
    if (failAt === "close" && command === "fmc_revit_file" && params.action === "close") {
      throw new Error("Revit can't close the active model from a plugin: open another first, or the person closes it");
    }
    if (failAt === "activate" && command === "fmc_revit_file" && params.action === "open" && params.path === local) {
      throw new Error("An internal error has occurred");
    }
    if (command === "fmc_new_local") return made;
    return { opened: params.path, closed: params.title };
  };
  return { sent, sendCommand, copy: (plan: NewLocalPlan) => { copied = plan; }, copied: () => copied };
}

test("switch refused closes nothing; close refused stays closed false; activate refused leaves the local in the background", async () => {
  const plan = planNewLocal(input({ dry_run: false }), ctx());
  assert.equal(plan.ok, true, plan.reasons.join(" | "));

  const switched = harness("switch");
  const switchResult = await runNewLocalSteps(plan, switched.sendCommand, switched.copy);
  assert.equal(switchResult.ok, false);
  assert.equal(switchResult.step, "switch");
  assert.equal(switchResult.closed, false);
  assert.match(switchResult.message ?? "", /Nothing was closed/);
  assert.deepEqual(switched.sent.map((c) => c.command), ["fmc_revit_file"]);
  assert.equal(switched.copied(), undefined);

  const closed = harness("close");
  const closeResult = await runNewLocalSteps(plan, closed.sendCommand, closed.copy);
  assert.equal(closeResult.ok, false);
  assert.equal(closeResult.step, "close");
  assert.equal(closeResult.closed, false);
  assert.match(closeResult.message ?? "", /active model/);
  assert.deepEqual(closed.sent.map((c) => [c.command, c.params.action]), [
    ["fmc_revit_file", "open"],
    ["fmc_revit_file", "close"],
  ]);
  assert.equal(closed.sent[0].params.path, "C:\\WIP\\Sketch.rvt");
  assert.equal(closed.sent[1].params.save, false);
  assert.equal(closed.copied(), undefined);

  const background = harness("activate");
  const backgroundResult = await runNewLocalSteps(plan, background.sendCommand, background.copy);
  assert.equal(backgroundResult.ok, true);
  assert.equal(backgroundResult.active, false);
  assert.match(backgroundResult.note ?? "", /background/);
  assert.equal(background.copied()?.local, local);
  assert.notEqual(background.copied()?.local, central);

  const happy = harness();
  const done = await runNewLocalSteps(plan, happy.sendCommand, happy.copy);
  assert.equal(done.ok, true);
  assert.equal(done.active, true);
  assert.equal(done.title, "Architecture");
  assert.equal(done.path, local);
  assert.equal(done.isWorkshared, true);
  assert.equal(done.isLocal, true);
  assert.equal(done.central, central);
  assert.equal(done.worksets, 4);
  assert.equal(done.backup, plan.backup);
  assert.deepEqual(happy.sent.map((c) => c.command), ["fmc_revit_file", "fmc_revit_file", "fmc_new_local", "fmc_revit_file"]);
  assert.deepEqual(happy.sent[0], plan.calls[0]);
  assert.deepEqual(happy.sent[1], plan.calls[1]);
  assert.equal(happy.sent[2].params._script_document, "Sketch");
  assert.match(String(happy.sent[2].params.code), /WorksharingUtils\.CreateNewLocal/);
  assert.match(String(happy.sent[2].params.code), /OpenDocumentFile/);
  assert.deepEqual(happy.sent[3], plan.calls[3]);
});

function memFs(paths: string[]): MoveFs & { has(p: string): boolean } {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return {
    has: (p) => set.has(p.toLowerCase()),
    existsSync: (p) => set.has(p.toLowerCase()),
    renameSync: (from, to) => {
      if (!set.has(from.toLowerCase())) throw new Error(`ENOENT ${from}`);
      if (set.has(to.toLowerCase())) throw new Error(`EEXIST ${to}`);
      set.delete(from.toLowerCase());
      set.add(to.toLowerCase());
    },
  };
}

test("the old local is renamed to the next free backup, and its _backup folder is moved", () => {
  const taken = local + ".bak-20261118";
  const folder = "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001_backup";
  const plan = planNewLocal(input(), ctx({
    exists: (p) => [central, local, taken, folder].some((item) => item.toLowerCase() === p.toLowerCase()),
  }));
  assert.equal(plan.ok, true, plan.reasons.join(" | "));
  assert.equal(plan.backup, local + ".bak-20261118-2");
  assert.equal(plan.backup_folder_from, folder);
  assert.equal(plan.backup_folder_to, folder + ".bak-20261118-2");
  const disk = memFs([local, taken, folder, central]);
  moveBackup(plan, disk);
  assert.equal(disk.has(local), false);
  assert.equal(disk.has(plan.backup), true);
  assert.equal(disk.has(folder), false);
  assert.equal(disk.has(plan.backup_folder_to), true);
  assert.equal(disk.has(central), true);
  assert.equal(disk.has(taken), true);
});

test("resume when the document is closed, and a target that is still there after the move stops before CreateNewLocal", async () => {
  const resume = planNewLocal(input({ document: "ELECTRICAL_USER", dry_run: true }), ctx({
    docs: [doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "", isActive: true })],
    exists: (p) => p.toLowerCase() === central.toLowerCase() || p.toLowerCase() === local.toLowerCase(),
  }));
  assert.equal(resume.ok, true, resume.reasons.join(" | "));
  assert.equal(resume.resume, true);
  assert.equal(resume.closes, false);
  assert.match(resume.steps[0], /resume: document is closed/);
  assert.deepEqual(resume.calls.map((c) => c.command), ["fmc_new_local", "fmc_revit_file"]);
  assert.equal(resume.calls[1].params.action, "open");
  assert.equal(resume.calls[1].params.path, local);
  assert.equal(resume.script_document, "Sketch");

  const sent: string[] = [];
  const stuck: MoveFs = {
    existsSync: (p) => p.toLowerCase() === local.toLowerCase(),
    renameSync: () => { /* the rename did not remove the target */ },
  };
  const stopped = await runNewLocalSteps(resume, async (command) => {
    sent.push(command);
    return made;
  }, (p) => moveBackup(p, stuck));
  assert.equal(stopped.ok, false);
  assert.equal(stopped.step, "backup");
  assert.match(stopped.message ?? "", /still at/);
  assert.deepEqual(sent, []);
});

test("a closed document is never the Revit document of a dry run or a real run", async () => {
  const title = "HEBERT HOSTELS ELECTRICAL_USER";
  const host = "HEBERT HOSTELS_USER";
  const localPath = "C:\\WIP\\HEBERT HOSTELS ELECTRICAL_USER.rvt";
  const centralPath = "C:\\WIP\\HEBERT HOSTELS ELECTRICAL_central.rvt";
  const raw: Array<{ command: string; params: Record<string, unknown> }> = [];
  const commands: Array<{ command: string; params: Record<string, unknown> }> = [];
  const info = {
    documents: [
      { title: host, path: "C:\\WIP\\HEBERT HOSTELS_USER.rvt", isFamily: false, isWorkshared: true, isActive: true, isLinked: false },
      { title: "FMC_P_PlumbingFixture_ShowerTray_Param", path: "C:\\Fam\\Shower.rfa", isFamily: true, isWorkshared: false, isActive: false },
    ],
  };
  const probe = {
    success: true,
    result: JSON.stringify({
      ok: true, exists: true, isWorkshared: true, isCentral: true, centralPath,
      docFound: false, docTitle: "", docPath: "", docFamily: false, docWorkshared: false, docDetached: false, docActive: false, docCentral: "",
    }),
  };
  const io = {
    exists: (p: string) => p.toLowerCase() === localPath.toLowerCase() || p.toLowerCase() === centralPath.toLowerCase(),
    sendRaw: async (command: string, params: Record<string, unknown>) => {
      raw.push({ command, params });
      if (command === "fmc_document_info") return info;
      return probe;
    },
    sendCommand: async (command: string, params: Record<string, unknown>) => {
      commands.push({ command, params });
      if (params.document === title) throw new Error(`closed title sent: ${command}`);
      if (command === "fmc_new_local") {
        return { success: true, result: JSON.stringify({ ok: true, title: host, path: localPath, isWorkshared: true, isLocal: true, central: centralPath, worksets: 2, opened_how: "background" }) };
      }
      return { opened: params.path };
    },
  };
  const args = { document: title, central: centralPath, local: localPath, dry_run: true, batch_lease: "L1" };
  Object.assign(io, { holder: () => ({ lease: "L1", client: "stdio" }) });
  const dry = await runFmcNewLocal(args, io);
  const dryText = dry.content[0].text;
  assert.match(dryText, /resume: document is closed/);
  assert.equal(dry.isError, false);
  for (const call of raw) assert.notEqual(call.params.document, title, call.command);
  assert.equal(raw[0].params.document, localPath);
  assert.equal(raw.find((c) => c.command === "send_code_to_revit")?.params.document, host);
  assert.equal(commands.length, 0);
  const planned = JSON.parse(dryText) as { calls: Array<{ params: { document?: string } }> };
  for (const call of planned.calls) assert.notEqual(call.params.document, title);

  raw.length = 0;
  const real = await runFmcNewLocal({ ...args, dry_run: false }, io);
  assert.equal(real.isError, false);
  for (const call of [...raw, ...commands]) assert.notEqual(call.params.document, title, `${call.command} document`);
  const script = commands.find((c) => c.command === "fmc_new_local");
  assert.equal(script?.params.document, host);
  assert.equal(script?.params._script_document, host);
  assert.equal(script?.params._lease_document, title);
  assert.equal(script?.params._lock_document, "C:\\WIP\\HEBERT HOSTELS_USER.rvt");
  assert.equal(commands.find((c) => c.command === "fmc_revit_file")?.params._lock_document, localPath);
  assert.equal(wireNewLocal(script!.params).params.document, host);
});

test("a missing local is a resume with nothing to move", async () => {
  const host = "C:\\WIP\\Sketch.rvt";
  const exists = (p: string) => p.toLowerCase() === central.toLowerCase() || p.toLowerCase() === host.toLowerCase();
  const plan = planNewLocal(input({ document: "ELECTRICAL_USER" }), ctx({
    docs: [doc({ title: "Sketch", path: host, isWorkshared: true, isActive: true, centralPath: "" })],
    exists,
  }));
  assert.equal(plan.ok, true, plan.reasons.join(" | "));
  assert.equal(plan.resume, true);
  assert.match(plan.steps.join("\n"), /already gone/);
  assert.equal(plan.backup_folder_from, "");
  assert.equal(plan.backup_folder_to, "");
  assert.equal(documentInfoKey(local, central, exists), central);
  const disk = memFs([central, host]);
  moveBackup(plan, disk);
  assert.equal(disk.has(local), false);
  assert.equal(disk.has(central), true);
  const sent: string[] = [];
  const ran = await runNewLocalSteps(plan, async (command) => {
    sent.push(command);
    return made;
  });
  assert.equal(ran.ok, true);
  assert.deepEqual(sent, ["fmc_new_local", "fmc_revit_file"]);
});

test("a lock read on a missing local uses the open host, which exists", () => {
  const host = "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt";
  const localPath = "C:\\Users\\USER\\Documents\\HEBERT HOSTELS ELECTRICAL_USER.rvt";
  const centralPath = "C:\\Users\\USER\\Documents\\HEBERT HOSTELS ELECTRICAL_central.rvt";
  const exists = (p: string) => [host, centralPath].some((item) => item.toLowerCase() === p.toLowerCase());
  const plan = planNewLocal(input({ document: "HEBERT HOSTELS ELECTRICAL_USER", central: centralPath, local: localPath }), ctx({
    docs: [doc({ title: "HEBERT HOSTELS_USER", path: host, isWorkshared: true, isActive: true, centralPath: "" })],
    exists,
    centralFile: { exists: true, isWorkshared: true, isCentral: true, centralPath },
  }));
  assert.equal(plan.ok, true, plan.reasons.join(" | "));
  assert.equal(plan.resume, true);
  const make = plan.calls[0].params;
  assert.equal(make._lock_document, host);
  assert.equal(exists(String(make._lock_document)), true);
  assert.notEqual(make._lock_document, localPath);
  assert.notEqual(make._lock_document, centralPath);
  assert.equal(make._script_document, "HEBERT HOSTELS_USER");
  assert.equal(make.document, "HEBERT HOSTELS_USER");
  assert.equal(make._lease_document, "HEBERT HOSTELS ELECTRICAL_USER");
  assert.equal(plan.calls[1].params._lock_document, localPath);
  assert.equal(plan.calls[1].params.action, "open");
});

test("resume after a partial run skips the taken backup and still creates the local", () => {
  const host = "C:\\WIP\\Sketch.rvt";
  const bak = local + ".bak-20261118";
  const bak2 = local + ".bak-20261118-2";
  const exists = (p: string) => [central, host, bak, bak2].some((item) => item.toLowerCase() === p.toLowerCase());
  const plan = planNewLocal(input({ document: "ELECTRICAL_USER" }), ctx({
    docs: [doc({ title: "Sketch", path: host, isWorkshared: true, isActive: true, centralPath: "" })],
    exists,
  }));
  assert.equal(plan.ok, true, plan.reasons.join(" | "));
  assert.equal(plan.resume, true);
  assert.equal(plan.backup, local + ".bak-20261118-3");
  assert.equal(plan.backup_folder_from, "");
  assert.match(plan.steps.join("\n"), /already gone/);
  assert.doesNotMatch(plan.steps.join("\n"), /Rename /);
  assert.equal(plan.calls[0].params._lock_document, host);
  const disk = memFs([central, host, bak, bak2]);
  moveBackup(plan, disk);
  assert.equal(disk.has(local), false);
  assert.equal(disk.has(bak2), true);
  assert.equal(disk.has(plan.backup), false);
});

test("FromFile of the backup or the central is refused as a central; the open host is not", () => {
  const proposal = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "kit-proposals", "FMC_Rulebook_AIUse.json"), "utf8");
  const book = parseRulebook(proposal).book;
  assert.ok(book);
  const full: AiModellerConfig = { on: true, stop: false, access: "full", mode: "testing", general: true, allow_code: true, projects: {}, levels: {} };
  const empty = { day: "", models: {} };
  const fromFile = (title: string, file: string) => ({ title, path: file, isFamily: false, isWorkshared: true, isActive: false });
  const backup = fromFile("HEBERT HOSTELS ELECTRICAL_USER.rvt.bak-20261118-2", local + ".bak-20261118-2");
  const centralDoc = fromFile("central", central);
  for (const docInfo of [backup, centralDoc]) {
    const verdict = aiVerdict({ command: "fmc_new_local", doc: docInfo, elements: 0, approved: true }, cfg, book, full, empty);
    assert.match(verdict.reasons[0] ?? "", /central model/, docInfo.path);
    assert.equal(writeGuard(docInfo, "fmc_new_local", {}, cfg).ok, true, docInfo.path);
  }
  const host = { title: "HEBERT HOSTELS_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt", isFamily: false, isWorkshared: true, isLocal: true };
  assert.equal(aiVerdict({ command: "fmc_new_local", doc: host, elements: 0, approved: true }, cfg, book, full, empty).ok, true);
});

test("a real run needs the caller's lease; a dry run does not", () => {
  const none = planNewLocal(input({ dry_run: false }), ctx({ holder: null, caller: { client: "stdio", lease: "" } }));
  assert.equal(none.ok, false);
  assert.match(none.reasons.join(" "), /needs the batch lease/);
  const unheld = planNewLocal(input({ dry_run: false }), ctx({ holder: null, caller: { client: "stdio", lease: "made-up" } }));
  assert.match(unheld.reasons.join(" "), /needs the batch lease/);
  const dry = planNewLocal(input(), ctx({ holder: null, caller: { client: "stdio", lease: "" } }));
  assert.equal(dry.ok, true, dry.reasons.join(" | "));
  const held = planNewLocal(input({ dry_run: false }), ctx());
  assert.equal(held.ok, true, held.reasons.join(" | "));
});

test("unsaved or unsynced changes refuse a real run unless discard_changes; the dry run reports them", () => {
  const dirty = (partial: Partial<OpenDoc>) => ctx({ docs: [
    doc({ title: "Architecture", path: local, isActive: false, modified: false, ownedWorksets: 0, ...partial }),
    doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "", isActive: true }),
  ] });
  const modified = planNewLocal(input({ dry_run: false }), dirty({ modified: true }));
  assert.equal(modified.ok, false);
  assert.match(modified.reasons.join(" "), /unsaved changes/);
  const held = planNewLocal(input({ dry_run: false }), dirty({ ownedWorksets: 2 }));
  assert.match(held.reasons.join(" "), /2 workset\(s\) still held/);
  const unknown = planNewLocal(input({ dry_run: false }), dirty({ modified: undefined, ownedWorksets: undefined }));
  assert.match(unknown.reasons.join(" "), /Could not read whether/);
  const failedRead = planNewLocal(input({ dry_run: false }), dirty({ ownedWorksets: -1 }));
  assert.match(failedRead.reasons.join(" "), /Could not read whether/);
  const discard = planNewLocal(input({ dry_run: false, discard_changes: true }), dirty({ modified: true, ownedWorksets: 2 }));
  assert.equal(discard.ok, true, discard.reasons.join(" | "));
  const dry = planNewLocal(input(), dirty({ modified: true, ownedWorksets: 1 }));
  assert.equal(dry.ok, true);
  assert.equal(dry.modified, true);
  assert.equal(dry.owned_worksets, 1);
  assert.match(dry.backup_contains, /last saved state/);
  const probe = newLocalProbeScript(central, local);
  assert.match(probe, /docModified/);
  assert.match(probe, /docOwnedWorksets/);
  assert.match(probe, /IsEditable/);
});

test("the old local is put back when CreateNewLocal fails, and never over a partial new local", async () => {
  const exists = (p: string) => [central, local].some((x) => x.toLowerCase() === p.toLowerCase());
  const plan = planNewLocal(input({ dry_run: false }), ctx({ exists }));
  assert.equal(plan.ok, true, plan.reasons.join(" | "));
  const disk = memFs([local, central]);
  const failing = async (command: string) => {
    if (command === "fmc_new_local") throw new Error("CreateNewLocal: the central is busy");
    return {};
  };
  const ran = await runNewLocalSteps(plan, failing, (p) => moveBackup(p, disk), (p) => restoreBackup(p, disk));
  assert.equal(ran.ok, false);
  assert.equal(ran.step, "create_local");
  assert.equal(ran.restored, true);
  assert.equal(disk.has(local), true);
  assert.equal(disk.has(plan.backup), false);
  assert.match(ran.message ?? "", /put back/);

  const refused = await runNewLocalSteps(plan, async (command) => command === "fmc_new_local" ? { success: true, result: JSON.stringify({ ok: false, step: "open_local", message: "open failed" }) } : {},
    (p) => moveBackup(p, disk), (p) => restoreBackup(p, disk));
  assert.equal(refused.restored, true);
  assert.equal(refused.step, "open_local");

  // a partial new local at the path: the old one stays at the backup name, nothing deleted
  const partial = memFs([plan.backup]);
  const kept = restoreBackup(plan, { existsSync: (p) => partial.has(p) || p.toLowerCase() === local.toLowerCase(), renameSync: partial.renameSync });
  assert.equal(kept.restored, false);
  assert.match(kept.message, /nothing was deleted/);
});
