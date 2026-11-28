import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, GuardConfig, WRITE_COMMANDS } from "./policy.js";
import { NEVER } from "./aiuse.js";
import { aiGate } from "./aigate.js";
import { readQueue, setStatus } from "./aiuse_io.js";
import { FMC_CENTRAL_SHAPE, runCentralFromPane, runFmcCentral, type FmcCentralArgs } from "../tools/fmc_central.js";
import { FMC_ISO_FOLDERS_SHAPE, runFmcIsoFolders } from "../tools/fmc_iso_folders.js";
import { CentralBuilder, DrivePort, SelfTestResult } from "./central.js";
import { forbiddenProjectIn } from "./iso19650.js";
import {
  CENTRAL_APPROVAL, CENTRAL_PERSON_ONLY_COMMANDS, canonicalPath, centralLeaseProblem, defaultCentralTempRoot,
  deleteOwnTemp, isInsideDir, isPerson, isUncPath, promoteTargetProblems, tempPathProblems,
} from "./centralguard.js";

const NOW = new Date("2026-11-28T09:00:00Z");
const ACCESS = { central_creators: [os.userInfo().username || "emlyn"], robots: ["family-kit-loader-bot"] };

function world(opts: { protectedRoots?: string[] | "project-parent"; standin?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_central_gate_"));
  const guard = path.join(dir, "fmc_guard.json");
  const project = opts.standin
    ? path.join(dir, "Fomcraft", "FMC_PROJECTS_27", "Proj")
    : path.join(dir, "share", "F26009");
  const wip = path.join(project, "01_WIP", "A");
  fs.mkdirSync(path.join(project, "00_Info", "Admin"), { recursive: true });
  fs.mkdirSync(wip, { recursive: true });
  fs.writeFileSync(path.join(project, "00_Info", "Admin", "FMC_Access.json"), JSON.stringify(ACCESS));
  const tpl = path.join(dir, "FMC_A_Template_v2.2.rte");
  fs.writeFileSync(tpl, "template");
  const local = path.join(dir, "Local");
  fs.mkdirSync(path.join(local, "Formcraft", "central-temp"), { recursive: true });
  const writeRoot = opts.standin
    ? path.join(dir, "Fomcraft", "FMC_PROJECTS_27", "*", "01_WIP")
    : path.join(dir, "share", "*", "01_WIP");
  const protectedRoots = opts.protectedRoots === "project-parent"
    ? [path.dirname(project)]
    : (opts.protectedRoots ?? ["D:\\Fomcraft"]);
  fs.writeFileSync(guard, JSON.stringify({
    write_roots: [writeRoot],
    protected_roots: protectedRoots,
    reports_dir: path.join(dir, "reports"),
  }));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: path.join(dir, "Roaming"), LOCALAPPDATA: local, FMC_GUARD_CONFIG: guard };
  delete env.FMC_CALLER;
  const tempRoot = path.join(local, "Formcraft", "central-temp");
  return {
    dir, project, tpl, env, tempRoot, guard,
    done: () => { if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old; fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const argsOf = (w: ReturnType<typeof world>, extra: Record<string, unknown> = {}): FmcCentralArgs => z.object(FMC_CENTRAL_SHAPE).parse({
  action: "create", project_folder: w.project, project: "F26009", originator: "FMC", volume: "ZZ", level: "ZZ", type: "M3",
  role: "A", number: 1, template_path: w.tpl, dry_run: false, confirmed_by: "Emlyn", batch_lease: "lease-1", ...extra,
});

const fakeBuilder = (): CentralBuilder & { calls: string[] } => {
  const calls: string[] = [];
  const pass = (ws: string[]): SelfTestResult => ({ ok: true, read_only_open: true, worksets_loaded: ws, missing_worksets: [], sync_verified: true, local_discarded: true, detail: "ok" });
  return {
    calls,
    build: async (req) => { calls.push("build:" + req.temp_path); fs.mkdirSync(path.dirname(req.temp_path), { recursive: true }); fs.writeFileSync(req.temp_path, "central"); },
    selfTest: async (_p, ws, throwaway) => { calls.push("test:" + throwaway); fs.mkdirSync(throwaway, { recursive: true }); fs.writeFileSync(path.join(throwaway, "local.rvt"), "l"); fs.rmSync(throwaway, { recursive: true, force: true }); return pass(ws); },
    promote: async (from, to) => { calls.push("promote:" + to); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); },
  };
};

const text = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
function testDrive(w: ReturnType<typeof world>): DrivePort {
  return {
    kind: (root: string) => isInsideDir(root, w.tempRoot) ? "local" : "network",
    reachable: () => true,
    freeBytes: () => 100 * 1024 * 1024 * 1024,
  };
}
const personCtx = (w: ReturnType<typeof world>) => ({ viaMcp: false as const, env: { ...w.env, FMC_CALLER: "pane" }, tempRoot: w.tempRoot, drive: testDrive(w) });
const mcpCtx = (w: ReturnType<typeof world>) => ({ viaMcp: true as const, env: w.env, tempRoot: w.tempRoot, drive: testDrive(w) });

// ---------- path safety

test("canonical paths and isInsideDir: neighbours and .. do not count as inside", () => {
  const root = "C:\\Users\\u\\AppData\\Local\\Formcraft\\central-temp";
  assert.equal(canonicalPath(root + "\\"), root);
  assert.equal(isInsideDir(root + "\\job\\a.rvt", root), true);
  assert.equal(isInsideDir(root, root), true);
  assert.equal(isInsideDir(root + "-evil\\a.rvt", root), false);
  assert.equal(isInsideDir("C:\\Users\\u\\AppData\\Local\\Formcraft\\central-temp\\..\\other", root), false);
  assert.equal(isUncPath("\\\\srv\\bim\\P"), true);
  assert.equal(isUncPath("C:\\Temp\\x"), false);
});

test("tempPathProblems: only a local canonical path inside the temp root is allowed", () => {
  const root = "C:\\Users\\u\\AppData\\Local\\Formcraft\\central-temp";
  const local = () => "local" as const;
  const net = () => "network" as const;
  assert.deepEqual(tempPathProblems(root + "\\job\\a.rvt", root, local), []);
  assert.match(tempPathProblems(root, root, local).join(), /temp root itself|strict subfolder/);
  assert.match(tempPathProblems(root + "\\", root, local).join(), /temp root itself|strict subfolder/);
  assert.match(tempPathProblems("\\\\srv\\bim\\t\\a.rvt", root, local).join(), /network share/);
  assert.match(tempPathProblems("Z:\\job\\a.rvt", root, net).join(), /network share/);
  assert.match(tempPathProblems("C:\\Windows\\Temp\\a.rvt", root, local).join(), /not inside the tool-owned temp root/);
  assert.match(tempPathProblems(root + "-evil\\a.rvt", root, local).join(), /not inside/);
  assert.match(tempPathProblems("relative\\a.rvt", root, local).join(), /not an absolute path/);
  assert.match(promoteTargetProblems(root + "\\x.rvt", root, local).join(), /inside the temp root/);
  assert.match(promoteTargetProblems("C:\\local\\01_WIP\\A\\x.rvt", root, local).join(), /Rule 4/);
  assert.deepEqual(promoteTargetProblems("\\\\srv\\bim\\P\\01_WIP\\A\\x.rvt", root, net), []);
  assert.match(promoteTargetProblems("\\\\srv\\bim\\P\\02_Shared\\A\\x.rvt", root, net).join(), /01_WIP/);
});

test("deleteOwnTemp refuses a path outside the temp root, a UNC path, and the root itself", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_del_"));
  try {
    const root = path.join(base, "Formcraft", "central-temp");
    const job = path.join(root, "job");
    const outsider = path.join(base, "important");
    fs.mkdirSync(job, { recursive: true });
    fs.mkdirSync(outsider);
    fs.writeFileSync(path.join(outsider, "keep.txt"), "x");
    const kind = () => "local" as const;
    const deleted: string[] = [];
    deleteOwnTemp(job, root, (p) => { deleted.push(p); fs.rmSync(p, { recursive: true, force: true }); }, kind);
    assert.equal(deleted.length, 1);
    assert.equal(fs.existsSync(job), false);
    assert.throws(() => deleteOwnTemp(outsider, root, () => { throw new Error("should not delete"); }, kind), /Refusing to delete/);
    assert.ok(fs.existsSync(path.join(outsider, "keep.txt")));
    assert.throws(() => deleteOwnTemp(root, root, () => { throw new Error("should not delete"); }, kind), /temp root itself/);
    assert.throws(() => deleteOwnTemp("\\\\srv\\bim\\P", root, () => { throw new Error("should not delete"); }, kind), /Refusing to delete/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("defaultCentralTempRoot is %LOCALAPPDATA%\\Formcraft\\central-temp", () => {
  assert.equal(defaultCentralTempRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }).toLowerCase(), "c:\\users\\u\\appdata\\local\\formcraft\\central-temp");
});

// ---------- lease (dynamo-style)

test("centralLeaseProblem: a write needs a lease, the same as fmc_dynamo apply", () => {
  assert.match(centralLeaseProblem(undefined) ?? "", /FMC-BATCH-LOCKED/);
  assert.match(centralLeaseProblem("  ") ?? "", /FMC-BATCH-LOCKED/);
  assert.equal(centralLeaseProblem("lease-1"), null, "a lease this process does not list is accepted, as in scriptexec (held.length === 0)");
});

// ---------- person vs AI

test("plan and dry-run stay ungated: no lease, no person, no queue", async () => {
  const w = world();
  try {
    const r = await runFmcCentral(argsOf(w, { action: "plan", dry_run: true, batch_lease: "", confirmed_by: "" }), fakeBuilder(), mcpCtx(w));
    const body = text(r);
    assert.equal(body.dry_run, true, JSON.stringify(body));
    assert.ok(body.would_do.plan_token);
    assert.equal(readQueue(w.env).length, 0);
  } finally { w.done(); }
});

test("an AI cannot self-confirm: confirmed_by and plan_token are not an approval; nothing is built", async () => {
  const w = world();
  try {
    const builder = fakeBuilder();
    const plan = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, mcpCtx(w)));
    const token = plan.would_do.plan_token;
    const r = await runFmcCentral(argsOf(w, { plan_token: token, confirmed_by: "I am definitely Emlyn", batch_lease: "lease-1" }), builder, mcpCtx(w));
    const body = text(r);
    assert.equal(r.isError, true);
    assert.equal(body.awaiting_person, true);
    assert.match(body.reasons[0], /not an approval|person has to approve/i);
    assert.equal(builder.calls.length, 0);
    assert.equal(readQueue(w.env)[0].command, CENTRAL_APPROVAL);
    assert.equal(fs.readdirSync(path.join(w.project, "01_WIP", "A")).length, 0, "no central written");
  } finally { w.done(); }
});

test("FMC_CALLER=pane on an MCP call is not a person", async () => {
  const w = world();
  try {
    const builder = fakeBuilder();
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, mcpCtx(w))).would_do.plan_token;
    const r = await runFmcCentral(argsOf(w, { plan_token: token }), builder, { viaMcp: true, env: { ...w.env, FMC_CALLER: "pane" }, tempRoot: w.tempRoot, drive: testDrive(w) });
    assert.equal(text(r).awaiting_person, true);
    assert.equal(builder.calls.length, 0);
    assert.equal(isPerson({ viaMcp: true, env: { FMC_CALLER: "pane" } }), false);
    assert.equal(isPerson({ viaMcp: false, env: { FMC_CALLER: "pane" } }), true);
  } finally { w.done(); }
});

test("a real create without a batch lease is refused with FMC-BATCH-LOCKED, before any queue item", async () => {
  const w = world();
  try {
    const builder = fakeBuilder();
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, personCtx(w))).would_do.plan_token;
    const r = await runFmcCentral(argsOf(w, { plan_token: token, batch_lease: "" }), builder, personCtx(w));
    assert.equal(text(r).code, "FMC-BATCH-LOCKED");
    assert.equal(builder.calls.length, 0);
    assert.equal(readQueue(w.env).length, 0);
  } finally { w.done(); }
});

test("a person's pane click with a lease and a matching plan_token can create the central", async () => {
  const w = world();
  try {
    const builder = fakeBuilder();
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, personCtx(w))).would_do.plan_token;
    const r = await runFmcCentral(argsOf(w, { plan_token: token }), builder, personCtx(w));
    const body = text(r);
    assert.equal(body.status, "ready", JSON.stringify(body));
    assert.ok(builder.calls.some((c) => c.startsWith("build:")));
    assert.ok(builder.calls.some((c) => c.startsWith("promote:")));
    assert.ok(fs.existsSync(body.target));
  } finally { w.done(); }
});

test("an approved AI still has no path: the pane must run save-as-central", async () => {
  const w = world();
  try {
    const builder = fakeBuilder();
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, mcpCtx(w))).would_do.plan_token;
    const first = text(await runFmcCentral(argsOf(w, { plan_token: token }), builder, mcpCtx(w)));
    assert.ok(setStatus(first.approval_id, "approved", "Emlyn", w.env, NOW));
    const again = text(await runFmcCentral(argsOf(w, { plan_token: token }), builder, mcpCtx(w)));
    assert.equal(again.awaiting_person, true);
    assert.match(again.reasons[0], /no AI path/);
    assert.equal(builder.calls.length, 0);
  } finally { w.done(); }
});

test("runCentralFromPane forces a person context (viaMcp false, FMC_CALLER=pane)", async () => {
  const w = world();
  try {
    const builder = fakeBuilder();
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, mcpCtx(w))).would_do.plan_token;
    const seen: Array<{ viaMcp?: boolean; caller?: string }> = [];
    await runCentralFromPane({ args: { ...argsOf(w, { plan_token: token }), dry_run: false } }, { env: w.env, tempRoot: w.tempRoot, drive: testDrive(w) },
      async (args, _b, ctx) => { seen.push({ viaMcp: ctx.viaMcp, caller: ctx.env?.FMC_CALLER }); return runFmcCentral(args, builder, { ...ctx, tempRoot: w.tempRoot, drive: testDrive(w) }); });
    assert.deepEqual(seen, [{ viaMcp: false, caller: "pane" }]);
    assert.ok(builder.calls.some((c) => c.startsWith("build:")));
  } finally { w.done(); }
});

test("queue_run does not reuse a stored confirmed_by as a new approval; a person must confirm again", async () => {
  const w = world();
  try {
    const empty = text(await runFmcCentral(argsOf(w, { action: "queue_run", job_id: "nope", confirmed_by: "stored-person", batch_lease: "lease-1" }), fakeBuilder(), mcpCtx(w)));
    assert.equal(empty.empty, true);
    const busy: CentralBuilder & { calls: string[] } = fakeBuilder();
    busy.build = async () => { throw new Error("[FMC-CENTRAL-BUSY] held by another session"); };
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), busy, personCtx(w))).would_do.plan_token;
    const queued = text(await runFmcCentral(argsOf(w, { plan_token: token }), busy, personCtx(w)));
    assert.equal(queued.status, "queued", JSON.stringify(queued));
    const replay = fakeBuilder();
    const asAi = text(await runFmcCentral(argsOf(w, { action: "queue_run", job_id: queued.job.id, confirmed_by: queued.job.confirmed_by, batch_lease: "lease-1" }), replay, mcpCtx(w)));
    assert.equal(asAi.awaiting_person, true, JSON.stringify(asAi));
    assert.match(asAi.reasons[0], /not an approval|person has to approve|no AI path/i);
    assert.equal(replay.calls.length, 0);
  } finally { w.done(); }
});

test("queue_remove needs a lease and a person (or a pane approval); AI confirm is refused", async () => {
  const w = world();
  try {
    const noLease = text(await runFmcCentral(argsOf(w, { action: "queue_remove", job_id: "abc", batch_lease: "" }), fakeBuilder(), mcpCtx(w)));
    assert.equal(noLease.code, "FMC-BATCH-LOCKED");
    const wait = text(await runFmcCentral(argsOf(w, { action: "queue_remove", job_id: "abc", batch_lease: "lease-1" }), fakeBuilder(), mcpCtx(w)));
    assert.equal(wait.awaiting_person, true);
    const person = text(await runFmcCentral(argsOf(w, { action: "queue_remove", job_id: "abc", batch_lease: "lease-1" }), fakeBuilder(), personCtx(w)));
    assert.equal(person.removed, false);
  } finally { w.done(); }
});

test("fmc_iso_folders create is not self-confirmable with only a plan_token; a person or pane approval is required", async () => {
  const w = world();
  try {
    const folder = path.join(w.dir, "NewProj");
    const shape = { action: "create" as const, project_folder: folder, code: "F26011", roles: ["A"], central_creators: ["emlyn"], dry_run: false };
    const plan = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({ ...shape, action: "plan", dry_run: true }), mcpCtx(w)));
    const token = plan.would_create.plan_token;
    const ai = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({ ...shape, plan_token: token }), mcpCtx(w)));
    assert.equal(ai.awaiting_person, true);
    assert.equal(fs.existsSync(folder), false);
    const done = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({ ...shape, plan_token: token }), personCtx(w)));
    assert.equal(done.done, true, JSON.stringify(done));
    assert.ok(fs.existsSync(path.join(folder, "04_Archive")));
    assert.ok(fs.existsSync(path.join(folder, "robots")));
  } finally { w.done(); }
});

test("the three Revit write commands are in WRITE_COMMANDS and NEVER, and the AI gate refuses them even with no document (no AI path, including access=full)", async () => {
  for (const c of CENTRAL_PERSON_ONLY_COMMANDS) {
    assert.ok(WRITE_COMMANDS.has(c), c);
    assert.ok(NEVER[c], c);
  }
  for (const c of CENTRAL_PERSON_ONLY_COMMANDS) {
    const g = await aiGate(c, {}, null, { ...DEFAULT_CONFIG } as GuardConfig, async () => ({}));
    assert.equal(g.ok, false, c);
    assert.match(g.reason || g.user || "", /person-only|no AI path|rule 6/i);
  }
});


test("forbidden projects are refused on the project code and name, not only as path segments", () => {
  assert.equal(forbiddenProjectIn("Z:\\Projects\\A-0001\\01_WIP"), "A-0001");
  assert.equal(forbiddenProjectIn("Z:\\Projects\\New", ["A-0001"]), "A-0001");
  assert.equal(forbiddenProjectIn("Z:\\Projects\\New", ["A0001"]), "A-0001");
  assert.equal(forbiddenProjectIn("Z:\\Projects\\New", ["HEBERT HOSTELS"]), "HEBERT HOSTELS");
  assert.equal(forbiddenProjectIn("Z:\\Projects\\F26009", ["F26009"]), null);
});

test("decisions 1-5 are unchanged: 01_WIP\\<Role>, _v2 default, Architecture/Structure/MEP, 04_Archive and robots at the project root", async () => {
  const w = world();
  try {
    const plan = text(await runFmcCentral(argsOf(w, { action: "plan" }), fakeBuilder(), mcpCtx(w))).would_do;
    assert.match(plan.target, /01_WIP\\A\\F26009-FMC-ZZ-ZZ-M3-A-0001\.rvt$/);
    assert.deepEqual(plan.worksets, ["Architecture", "Structure", "MEP"]);
    fs.writeFileSync(path.join(w.project, "01_WIP", "A", "F26009-FMC-ZZ-ZZ-M3-A-0001.rvt"), "old");
    const v2 = text(await runFmcCentral(argsOf(w, { action: "plan" }), fakeBuilder(), mcpCtx(w))).would_do;
    assert.equal(v2.versioned, true);
    assert.match(v2.target, /_v2\.rvt$/);
    const iso = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({
      action: "plan", project_folder: path.join(w.dir, "EmptyP"), code: "F26012", roles: ["A"], dry_run: true,
    }), mcpCtx(w)));
    assert.match(iso.would_create.tree, /04_Archive\\/);
    assert.match(iso.would_create.tree, /robots\\/);
  } finally { w.done(); }
});

test("KL-T03: testing-mode auto_approve does not approve fmc_central or fmc_iso_folders creates", async () => {
  const w = world();
  try {
    const guard = JSON.parse(fs.readFileSync(w.guard, "utf8"));
    guard.ai_modeller = { on: true, mode: "testing", auto_approve: true, general: true, access: "full" };
    fs.writeFileSync(w.guard, JSON.stringify(guard));
    const builder = fakeBuilder();
    const token = text(await runFmcCentral(argsOf(w, { action: "plan" }), builder, mcpCtx(w))).would_do.plan_token;
    const r = text(await runFmcCentral(argsOf(w, { plan_token: token }), builder, mcpCtx(w)));
    assert.equal(r.awaiting_person, true, JSON.stringify(r));
    assert.equal(builder.calls.length, 0);
    assert.equal(fs.readdirSync(path.join(w.project, "01_WIP", "A")).length, 0, "no central written");

    const folder = path.join(w.dir, "AutoProj");
    const shape = { action: "create" as const, project_folder: folder, code: "F26013", roles: ["A"], central_creators: ["emlyn"], dry_run: false };
    const isoPlan = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({ ...shape, action: "plan", dry_run: true }), mcpCtx(w)));
    const iso = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({ ...shape, plan_token: isoPlan.would_create.plan_token }), mcpCtx(w)));
    assert.equal(iso.awaiting_person, true, JSON.stringify(iso));
    assert.equal(fs.existsSync(folder), false);

    for (const c of CENTRAL_PERSON_ONLY_COMMANDS) {
      const g = await aiGate(c, {}, null, { ...DEFAULT_CONFIG, ai_modeller: { on: true, mode: "testing", auto_approve: true, general: true, access: "full" } } as GuardConfig, async () => ({}));
      assert.equal(g.ok, false, c);
      assert.match(g.reason || g.user || "", /person-only|no AI path|rule 6/i);
    }
  } finally { w.done(); }
});

test("KL-T07: empty protected_roots does not refuse a Fomcraft project-tree stand-in", async () => {
  const w = world({ protectedRoots: [], standin: true });
  try {
    const plan = text(await runFmcCentral(argsOf(w, { action: "plan" }), fakeBuilder(), mcpCtx(w)));
    assert.ok(plan.would_do, JSON.stringify(plan));
    assert.equal((plan.would_do.reasons ?? []).filter((r: string) => /protected root/i.test(r)).length, 0);
    assert.match(plan.would_do.target, /Fomcraft\\FMC_PROJECTS_27\\Proj\\01_WIP\\A\\/);
  } finally { w.done(); }
});

test("KL-T08: a named originals folder in protected_roots is fail-closed for create and iso-folders", async () => {
  const w = world({ protectedRoots: "project-parent" });
  try {
    const plan = text(await runFmcCentral(argsOf(w, { action: "plan" }), fakeBuilder(), mcpCtx(w)));
    const reasons = (plan.would_do?.reasons ?? plan.reasons ?? []).join(" | ");
    assert.match(reasons, /protected root/, JSON.stringify(plan));
    const folder = path.join(path.dirname(w.project), "InsideOriginals");
    const iso = text(await runFmcIsoFolders(z.object(FMC_ISO_FOLDERS_SHAPE).parse({
      action: "plan", project_folder: folder, code: "F26014", roles: ["A"], dry_run: true,
    }), mcpCtx(w)));
    const isoReasons = (iso.would_create?.reasons ?? iso.reasons ?? []).join(" | ");
    assert.match(isoReasons, /protected root/, JSON.stringify(iso));
    assert.equal(fs.existsSync(folder), false);
  } finally { w.done(); }
});
