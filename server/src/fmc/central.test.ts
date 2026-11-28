import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import {
  BUSY_CODE, CentralBuilder, CentralInput, CentralPorts, DEFAULT_WORKSETS, DrivePort, FileReader, LogSink, SelfTestResult, TxFs,
  centralName, centralNameProblems, checkSharedDrive, driveRoot, fileQueue, logLine, memoryQueue, nextFreeName, permissionProblems,
  planCentral, runCentral, worksetProblems,
} from "./central.js";
import { csvLog, fileStore, realTxFs, windowsDriveKind } from "./centralports.js";

const ROOT = "Z:\\Projects\\F26009";
const WIP = ROOT + "\\01_WIP\\A";
const TPL = "Z:\\00_Standards\\06_Templates\\FMC_A_Template_v2.2.rte";
const cfg: GuardConfig = { ...DEFAULT_CONFIG, write_roots: ["Z:\\Projects\\*\\01_WIP"], protected_roots: ["D:\\Fomcraft"] };
const NOW = new Date("2026-11-28T07:00:00Z");
const GB = 1e9;

function reader(files: Record<string, unknown>, sizes: Record<string, number> = {}): FileReader {
  const k = (p: string) => p.toLowerCase();
  const map = new Map(Object.entries(files).map(([p, v]) => [k(p), v]));
  return {
    exists: (p) => map.has(k(p)),
    readJson: (p) => (map.has(k(p)) && typeof map.get(k(p)) === "object" ? map.get(k(p)) : null),
    list: (p) => [...map.keys()].filter((x) => path.win32.dirname(x) === k(p)).map((x) => path.win32.basename(x)),
    size: (p) => sizes[p] ?? null,
  };
}

const drive = (o: Partial<{ kind: string; reachable: boolean; free: number | null }> = {}): DrivePort => ({
  kind: () => (o.kind ?? "network") as never, reachable: () => o.reachable ?? true, freeBytes: () => (o.free === undefined ? 100 * GB : o.free),
});

const ACCESS = { central_creators: ["emlyn"], robots: ["family-kit-loader-bot"] };
const baseFiles = (extra: Record<string, unknown> = {}) => ({
  [ROOT]: true, [WIP]: true, [TPL]: true, [ROOT + "\\00_Info\\Admin\\FMC_Access.json"]: ACCESS, ...extra,
});

const input = (o: Partial<CentralInput> = {}): CentralInput => ({
  project_folder: ROOT, project: "F26009", originator: "FMC", volume: "ZZ", level: "ZZ", type: "M3", role: "A", number: 1,
  template_path: TPL, user: "emlyn", ...o,
});

const plan = (o: Partial<CentralInput> = {}, files: Record<string, unknown> = baseFiles(), d = drive()) => planCentral(input(o), cfg, reader(files), d, "C:\\T", NOW);

// ---- rule 8 name

test("rule 8: ISO 19650 name [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt", () => {
  const p = { project: "F26009", originator: "FMC", volume: "ZZ", level: "ZZ", type: "M3", role: "A", number: 1 };
  assert.equal(centralName(p), "F26009-FMC-ZZ-ZZ-M3-A-0001.rvt");
  assert.deepEqual(centralNameProblems(p), []);
  assert.equal(centralNameProblems({ ...p, project: "FMC", originator: "F", volume: "Z", level: "001", type: "XX", role: "QQ", number: 0 }).length, 7);
});

// ---- rule 9 versioning

test("rule 9: _v2, _v3… when the name exists", () => {
  const have = new Set(["z:\\p\\a.rvt", "z:\\p\\a_v2.rvt"]);
  assert.deepEqual(nextFreeName("Z:\\P", "a.rvt", () => false), { name: "a.rvt", versioned: false });
  assert.deepEqual(nextFreeName("Z:\\P", "a.rvt", (p) => have.has(p.toLowerCase())), { name: "a_v3.rvt", versioned: true });
  assert.throws(() => nextFreeName("Z:\\P", "a.rvt", () => true, 3), /No free version/);
});

test("rule 9 in the plan: an existing central gives a _v2 by default and is not touched", () => {
  const p = plan({}, baseFiles({ [WIP + "\\F26009-FMC-ZZ-ZZ-M3-A-0001.rvt"]: true }));
  assert.deepEqual(p.reasons, []);
  assert.equal(p.name, "F26009-FMC-ZZ-ZZ-M3-A-0001_v2.rvt");
  assert.equal(p.versioned, true);
  assert.equal(p.overwrite, false);
  assert.deepEqual(p.backup_moves, []);
  assert.match(p.ask_user, /new version/);
});

// ---- rule 2 overwrite

test("rule 2: overwrite needs a reason and backs the old central (and its _backup folder) up to _Archive", () => {
  const files = baseFiles({ [WIP + "\\F26009-FMC-ZZ-ZZ-M3-A-0001.rvt"]: true, [WIP + "\\F26009-FMC-ZZ-ZZ-M3-A-0001_backup"]: true });
  assert.match(plan({ overwrite: true }, files).reasons.join(), /override_reason/);
  const p = plan({ overwrite: true, override_reason: "corrupt central, owner approved" }, files);
  assert.deepEqual(p.reasons, []);
  assert.equal(p.overwrite, true);
  assert.equal(p.name, "F26009-FMC-ZZ-ZZ-M3-A-0001.rvt");
  assert.equal(p.backup_moves.length, 2);
  assert.ok(p.backup_moves.every(([, to]) => to.startsWith(WIP + "\\_Archive\\")));
  assert.match(p.ask_user, /OVERRIDE/);
});

// ---- rule 3 worksets

test("rule 3: Architecture/Structure/MEP by default, custom allowed and validated", () => {
  assert.deepEqual(plan().worksets, DEFAULT_WORKSETS);
  assert.deepEqual(plan({ worksets: ["A_Shell", "A_Interior"] }).worksets, ["A_Shell", "A_Interior"]);
  assert.match(plan({ worksets: ["A", "a"] }).reasons.join(), /listed twice/);
  assert.match(worksetProblems(["Bad|Name", ""]).reasons.join(), /character|blank/);
  assert.match(worksetProblems(["Shared Levels and Grids"]).reasons.join(), /Revit's own/);
  assert.ok(worksetProblems(DEFAULT_WORKSETS).warnings.length > 0, "MAN 4.6 naming gap is reported as a warning");
});

// ---- rule 4 + 10 drive

test("rule 4: never local; rule 10: reachable with space", () => {
  assert.equal(driveRoot("\\\\srv\\bim\\P\\x.rvt"), "\\\\srv\\bim\\");
  assert.equal(driveRoot("z:\\P"), "Z:\\");
  assert.deepEqual(checkSharedDrive("\\\\srv\\bim\\P", drive({ kind: "local" }), GB).reasons, [], "UNC is network");
  assert.match(plan({}, baseFiles(), drive({ kind: "local" })).reasons.join(), /Rule 4/);
  assert.match(plan({}, baseFiles(), drive({ reachable: false })).reasons.join(), /isn't reachable/);
  assert.match(plan({}, baseFiles(), drive({ free: 1 * GB })).reasons.join(), /GB free/);
  assert.match(plan({}, baseFiles(), drive({ free: null })).reasons.join(), /can't be read/);
  assert.equal(windowsDriveKind("Z:\\", () => "4"), "network");
  assert.equal(windowsDriveKind("C:\\", () => "3"), "local");
  assert.equal(windowsDriveKind("E:\\", () => { throw new Error("x"); }), "unknown");
});

test("rule 4: the ISO 19650 folder must exist and be inside the guard's write roots", () => {
  const files = baseFiles(); delete (files as Record<string, unknown>)[WIP];
  assert.match(plan({}, files).reasons.join(), /fmc_iso_folders first/);
  assert.match(plan({ project_folder: "Y:\\Other\\F26009" }, { [TPL]: true }).reasons.join(), /Guard: Not inside an allowed write folder/);
});

// ---- rule 5 permissions

test("rule 5: the project access rules and robot rights decide", () => {
  assert.match(permissionProblems(null, { user: "emlyn" }, null).join(), /no 00_Info/);
  assert.deepEqual(permissionProblems(ACCESS, { user: "Emlyn" }, null), []);
  assert.match(permissionProblems(ACCESS, { user: "guest" }, null).join(), /central_creators/);
  assert.match(permissionProblems(ACCESS, { user: "emlyn", robot_id: "other-bot" }, null).join(), /isn't listed/);
  assert.match(permissionProblems(ACCESS, { user: "emlyn", robot_id: "family-kit-loader-bot" }, { robot_id: "family-kit-loader-bot", central_create: false }).join(), /central_create/);
  assert.deepEqual(permissionProblems(ACCESS, { user: "emlyn", robot_id: "family-kit-loader-bot" }, { robot_id: "family-kit-loader-bot", central_create: true }), []);
  assert.match(plan({ user: "guest" }).reasons.join(), /Rule 5/);
});

// ---- rule 1 + 7 preview

test("rules 1 + 7: the preview quotes the path, the worksets and any detach, with a stable token", () => {
  const src = "Z:\\Projects\\F26009\\01_WIP\\S\\old.rvt";
  const p = plan({ template_path: undefined, source_model: src, detach: "discard" }, baseFiles({ [src]: true }));
  assert.deepEqual(p.reasons, []);
  assert.match(p.ask_user, /Path: +Z:\\Projects\\F26009\\01_WIP\\A\\F26009-FMC-ZZ-ZZ-M3-A-0001\.rvt/);
  assert.match(p.ask_user, /Worksets: Architecture, Structure, MEP \(default\)/);
  assert.match(p.ask_user, /DISCARD/);
  assert.equal(plan().plan_token, plan().plan_token);
  assert.notEqual(plan().plan_token, plan({ worksets: ["X"] }).plan_token);
  assert.match(plan({ source_model: src }, baseFiles({ [src]: true })).reasons.join(), /not both/);
});

test("forbidden projects and protected roots are refused", () => {
  assert.match(plan({ project_folder: "Z:\\Projects\\HEBERT HOSTELS" }).reasons.join(), /no tool may touch/);
  assert.match(plan({ template_path: undefined, source_model: "Z:\\A-0001\\m.rvt" }).reasons.join(), /A-0001/);
  assert.match(plan({ project_folder: "D:\\Fomcraft\\F26009" }).reasons.join(), /protected root/);
});

// ---- the transaction with mocks

interface Sim { disk: Set<string>; calls: string[] }

function simPorts(sim: Sim, o: Partial<{ buildError: string; tempTest: Partial<SelfTestResult>; shareTest: Partial<SelfTestResult>; promoteError: string; free: number }> = {}): CentralPorts & { lines: string[] } {
  const lines: string[] = [];
  const k = (p: string) => p.toLowerCase();
  const pass = (ws: string[]): SelfTestResult => ({ ok: true, read_only_open: true, worksets_loaded: ws, missing_worksets: [], sync_verified: true, local_discarded: true, detail: "ok" });
  const builder: CentralBuilder = {
    build: async (req) => { sim.calls.push("build"); if (o.buildError) throw new Error(o.buildError); sim.disk.add(k(req.temp_path)); },
    selfTest: async (p, ws) => { sim.calls.push("test:" + (p.startsWith("C:") ? "temp" : "share")); return { ...pass(ws), ...(p.startsWith("C:") ? o.tempTest : o.shareTest) }; },
    promote: async (from, to) => { sim.calls.push("promote"); sim.disk.add(k(to)); if (o.promoteError) throw new Error(o.promoteError); sim.disk.delete(k(from)); },
  };
  const txfs: TxFs = {
    exists: (p) => sim.disk.has(k(p)), mkdir: (p) => { sim.disk.add(k(p)); },
    move: (a, b) => { sim.calls.push(`move ${path.win32.basename(a)}`); sim.disk.delete(k(a)); sim.disk.add(k(b)); },
    removeOwnTemp: (p) => { sim.calls.push("cleanup"); for (const x of [...sim.disk]) if (x.startsWith(k(p))) sim.disk.delete(x); },
  };
  const log: LogSink = { append: (l) => lines.push(l) };
  return { builder, fs: txfs, drive: drive({ free: o.free }), queue: memoryQueue(), log, now: () => NOW, lines };
}

test("rules 12 + 13 + 6: temp build → temp self-test → move → share self-test → ready, logged", async () => {
  const p = plan();
  const sim: Sim = { disk: new Set(), calls: [] };
  const ports = simPorts(sim);
  const out = await runCentral(p, input(), "Emlyn", ports);
  assert.equal(out.status, "ready");
  assert.deepEqual(sim.calls, ["build", "test:temp", "promote", "test:share", "cleanup"]);
  assert.ok(sim.disk.has(p.target.toLowerCase()));
  assert.equal(ports.lines.length, 1);
  assert.match(ports.lines[0], /^2026-11-28T07:00:00.000Z,emlyn,,Z:\\Projects\\F26009\\01_WIP\\A\\F26009-FMC-ZZ-ZZ-M3-A-0001\.rvt,ready,/);
});

test("rule 12: a failing temp self-test never reaches the share", async () => {
  const sim: Sim = { disk: new Set(), calls: [] };
  const out = await runCentral(plan(), input(), "Emlyn", simPorts(sim, { tempTest: { worksets_loaded: ["Architecture"] } }));
  assert.equal(out.status, "aborted");
  assert.match((out as { reason: string }).reason, /missing worksets: Structure, MEP/);
  assert.ok(!sim.calls.includes("promote"));
  assert.equal([...sim.disk].length, 0);
});

test("rule 12: a failed promote is quarantined, never left half-made", async () => {
  const sim: Sim = { disk: new Set(), calls: [] };
  const p = plan();
  const out = await runCentral(p, input(), "Emlyn", simPorts(sim, { promoteError: "network dropped" }));
  assert.equal(out.status, "aborted");
  assert.ok(!sim.disk.has(p.target.toLowerCase()));
  assert.ok([...sim.disk].some((x) => x.includes("_archive\\failed_")));
});

test("rules 2 + 12: a failed share self-test after an override puts the old central back", async () => {
  const name = WIP + "\\F26009-FMC-ZZ-ZZ-M3-A-0001.rvt";
  const p = plan({ overwrite: true, override_reason: "owner approved" }, baseFiles({ [name]: true }));
  const sim: Sim = { disk: new Set([name.toLowerCase()]), calls: [] };
  const out = await runCentral(p, input({ overwrite: true, override_reason: "owner approved" }), "Emlyn",
    simPorts(sim, { shareTest: { sync_verified: false } }));
  assert.equal(out.status, "aborted");
  assert.match((out as { reason: string }).reason, /sync not verified/);
  assert.ok(sim.disk.has(name.toLowerCase()), "the original central is back in place");
  assert.ok((out as { rolled_back: string[] }).rolled_back.some((r) => r.startsWith("restored")));
});

test("rule 11: a busy detach is queued behind the other session", async () => {
  const sim: Sim = { disk: new Set(), calls: [] };
  const ports = simPorts(sim, { buildError: `[${BUSY_CODE}] old.rvt is open in another Revit session (pid 4242)` });
  const out = await runCentral(plan(), input(), "Emlyn", ports);
  assert.equal(out.status, "queued");
  assert.equal((out as { position: number }).position, 1);
  assert.equal(ports.queue.list().length, 1);
  assert.match(ports.lines[0], /,queued,/);
  const again = await runCentral(plan(), input(), "Emlyn", ports);
  assert.equal(ports.queue.list().length, 1, "the same target is queued once");
  assert.equal(again.status, "queued");
});

test("rules 1 + 10 at run time: no yes, a dropped drive, or a target that appeared all abort before any build", async () => {
  const sim: Sim = { disk: new Set(), calls: [] };
  assert.match(((await runCentral(plan(), input(), " ", simPorts(sim))) as { reason: string }).reason, /Rule 1/);
  assert.match(((await runCentral(plan(), input(), "Emlyn", simPorts(sim, { free: 0 }))) as { reason: string }).reason, /Rule 10/);
  const p = plan();
  const sim2: Sim = { disk: new Set([p.target.toLowerCase()]), calls: [] };
  assert.match(((await runCentral(p, input(), "Emlyn", simPorts(sim2))) as { reason: string }).reason, /appeared since the dry run/);
  assert.deepEqual(sim.calls, []);
  assert.deepEqual(sim2.calls, []);
});

// ---- real ports on temp folders (no share, no Revit)

test("temp folders: realTxFs moves, never overwrites, and deletes only inside its own temp root", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_central_"));
  try {
    const tempRoot = path.join(base, "temp");
    const share = path.join(base, "share");
    fs.mkdirSync(path.join(tempRoot, "job"), { recursive: true });
    fs.mkdirSync(share);
    const tx = realTxFs(tempRoot);
    fs.writeFileSync(path.join(tempRoot, "job", "c.rvt"), "x");
    tx.move(path.join(tempRoot, "job", "c.rvt"), path.join(share, "c.rvt"));
    assert.ok(fs.existsSync(path.join(share, "c.rvt")));
    fs.writeFileSync(path.join(tempRoot, "job", "c.rvt"), "y");
    assert.throws(() => tx.move(path.join(tempRoot, "job", "c.rvt"), path.join(share, "c.rvt")), /never overwrites/);
    assert.throws(() => tx.removeOwnTemp(share), /Refusing to delete/);
    assert.throws(() => tx.removeOwnTemp(tempRoot), /Refusing to delete/);
    tx.removeOwnTemp(path.join(tempRoot, "job"));
    assert.ok(!fs.existsSync(path.join(tempRoot, "job")));
    assert.ok(fs.existsSync(path.join(share, "c.rvt")));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("temp folders: the queue persists as JSON and the log is a timestamped CSV", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_central_"));
  try {
    const q = fileQueue(fileStore(path.join(base, "q", "FMC_Central_Queue.json")));
    const job = q.enqueue({ target: "Z:\\P\\a.rvt", plan_token: "t", input: input(), confirmed_by: "Emlyn", blocked_by: "busy" }, NOW);
    assert.equal(fileQueue(fileStore(path.join(base, "q", "FMC_Central_Queue.json"))).list()[0].id, job.id);
    assert.equal(q.remove(job.id), true);
    assert.deepEqual(q.list(), []);
    const file = path.join(base, "Admin", "FMC_Central_Log.csv");
    const log = csvLog(file);
    log.append(logLine(NOW, { user: "emlyn" }, "Z:\\P\\a.rvt", "ready", "ok"));
    log.append(logLine(NOW, { user: "emlyn", robot_id: "bot" }, "Z:\\P\\b.rvt", "aborted", "a, b"));
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r\n/);
    assert.equal(lines[0], "timestamp,user,robot,target,result,detail");
    assert.equal(lines.length, 3);
    assert.match(lines[2], /,bot,.*"a, b"$/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("temp folders: an end-to-end run with a fake Revit builder moves the central from temp onto a temp 'share'", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_central_"));
  try {
    const tempRoot = path.join(base, "temp");
    const root = path.join(base, "share", "F26009");
    const wip = path.join(root, "01_WIP", "A");
    fs.mkdirSync(wip, { recursive: true });
    fs.mkdirSync(path.join(root, "00_Info", "Admin"), { recursive: true });
    fs.writeFileSync(path.join(root, "00_Info", "Admin", "FMC_Access.json"), JSON.stringify(ACCESS));
    const tpl = path.join(base, "FMC_A_Template_v2.2.rte");
    fs.writeFileSync(tpl, "template");
    const c: GuardConfig = { ...cfg, write_roots: [path.join(base, "share", "*", "01_WIP")] };
    const { realReader } = await import("./centralports.js");
    const netDrive: DrivePort = { kind: () => "network", reachable: () => true, freeBytes: () => 100 * GB };
    const inp = input({ project_folder: root, template_path: tpl });
    const p = planCentral(inp, c, realReader, netDrive, tempRoot, NOW);
    assert.deepEqual(p.reasons, []);
    const builder: CentralBuilder = {
      build: async (req) => { fs.writeFileSync(req.temp_path, "central"); },
      selfTest: async (_p, ws, throwaway) => {
        fs.mkdirSync(throwaway, { recursive: true }); fs.writeFileSync(path.join(throwaway, "local.rvt"), "l"); fs.rmSync(throwaway, { recursive: true });
        return { ok: true, read_only_open: true, worksets_loaded: ws, missing_worksets: [], sync_verified: true, local_discarded: true, detail: "ok" };
      },
      promote: async (from, to) => { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); },
    };
    const out = await runCentral(p, inp, "Emlyn", { builder, fs: realTxFs(tempRoot), drive: netDrive, queue: memoryQueue(),
      log: csvLog(p.log_path), now: () => NOW });
    assert.equal(out.status, "ready", JSON.stringify(out));
    assert.equal(fs.readFileSync(p.target, "utf8"), "central");
    assert.ok(!fs.existsSync(p.temp_dir), "the temp build is cleaned up");
    assert.match(fs.readFileSync(p.log_path, "utf8"), /,ready,/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});


test("KL-T07: empty protected_roots does not refuse a Fomcraft project-tree stand-in", () => {
  const root = path.win32.join(os.tmpdir(), "fmc_central_t07", "Fomcraft", "FMC_PROJECTS_27", "Proj");
  const wip = path.win32.join(root, "01_WIP", "A");
  const empty: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.win32.join(os.tmpdir(), "fmc_central_t07", "Fomcraft", "FMC_PROJECTS_27", "*", "01_WIP")], protected_roots: [] };
  const files = { [root]: true, [wip]: true, [TPL]: true, [path.win32.join(root, "00_Info", "Admin", "FMC_Access.json")]: ACCESS };
  const p = planCentral(input({ project_folder: root, project: "PROJ" }), empty, reader(files), drive(), "C:\\T", NOW);
  assert.equal(p.reasons.filter((r) => /protected root/i.test(r)).length, 0, p.reasons.join(" | "));
  assert.deepEqual(p.reasons, [], p.reasons.join(" | "));
});

test("KL-T08: a named originals folder in protected_roots is fail-closed for a central plan inside it", () => {
  const originals = path.win32.join(os.tmpdir(), "fmc_central_t08", "named-originals");
  const root = path.win32.join(originals, "Proj");
  const wip = path.win32.join(root, "01_WIP", "A");
  const guarded: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.win32.join(originals, "*", "01_WIP")], protected_roots: [originals] };
  const files = { [originals]: true, [root]: true, [wip]: true, [TPL]: true, [path.win32.join(root, "00_Info", "Admin", "FMC_Access.json")]: ACCESS };
  const p = planCentral(input({ project_folder: root, project: "PROJ" }), guarded, reader(files), drive(), "C:\\T", NOW);
  assert.match(p.reasons.join(), /protected root/);
});
