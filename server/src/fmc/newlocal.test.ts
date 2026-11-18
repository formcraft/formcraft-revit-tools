import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig, WRITE_COMMANDS } from "./policy.js";
import { COMMAND_GROUPS, NEVER, aiVerdict } from "./aiuse.js";
import { documentRequired } from "./fairqueue.js";
import { explain } from "./explain.js";
import {
  CentralFile, NewLocalInput, OpenDoc, PlanContext, newLocalScript, planNewLocal, scriptLiteralProblem, wireNewLocal,
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
  const architecture = doc({ title: "Architecture", path: local, isActive: false });
  const sketch = doc({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt", isWorkshared: false, centralPath: "", isActive: true });
  return {
    cfg, now, exists: (p) => p.toLowerCase() === central.toLowerCase(),
    docs: [architecture, sketch],
    centralFile,
    holder: null,
    caller: { client: "stdio", lease: "" },
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

  const missing = planNewLocal(input({ document: "Plumbing" }), ctx());
  assert.match(missing.reasons.join(" "), /No open document is called "Plumbing"/);
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
  assert.equal(active.script_document, "Sketch");
  assert.match(active.steps.join("\n"), /Step 2: Architecture is active. Activate Sketch with UIApplication.OpenAndActivateDocument/);
  assert.equal(active.dry_run, true);
  assert.equal(active.closes, false);
  assert.equal(active.backup, "C:\\WIP\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt.bak-20261118");
  assert.match(active.steps.join("\n"), /Close\(false\)/);
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
  assert.match(idle.steps.join("\n"), /is not active/);
  assert.equal(wireNewLocal({ code: idle.script, _script_document: idle.script_document }).params.document, "Sketch");
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
  assert.throws(() => newLocalScript({
    central, local: 'C:\\WIP\\A".rvt', targetTitle: "Architecture", targetPath: local,
    switchTitle: "Sketch", switchPath: "C:\\WIP\\Sketch.rvt",
    backupFile: "C:\\WIP\\A.rvt.bak", backupFolderFrom: "", backupFolderTo: "",
  }), /quote or a newline/);

  const good = planNewLocal(input(), ctx());
  assert.equal(good.ok, true, good.reasons.join(" | "));
  const script = good.script ?? "";
  assert.match(script, /WorksharingUtils\.CreateNewLocal/);
  assert.match(script, /Close\(false\)/);
  assert.match(script, /WorksetConfigurationOption\.OpenAllWorksets/);
  assert.match(script, /OpenAndActivateDocument/);
  assert.match(script, /OpenDocumentFile/);
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
});
