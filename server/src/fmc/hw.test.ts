import { test } from "node:test";
import assert from "node:assert/strict";
import { healthReport } from "./httpservice.js";
import { runFmcHw } from "../tools/fmc_hw.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advise, applyGraphicsText, autoFreeIfHard, autosaveWouldSave, graphicsPlan, parseDriverDate, parseHost,
  lastAutoFree, planFree, primeHardwareScan, readGraphics, stripSecrets, upsertIni, writeIniAtomic, type HostRaw,
} from "./hw.js";
import { readQueue, setStatus } from "./aiuse_io.js";
import type { IniFs } from "./hwapproval.js";
import { clashPairs, dispatchJob, rayHitsAabb, rayVoxelHits, type GpuRunner } from "./hwgpu.js";
import { DEFAULT_CONFIG, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { resetAutoFreeThrottle } from "./hw.js";
import { NEVER } from "./aiuse.js";
import { MemoryGate, admitWrite, memoryLimits } from "./memory.js";
import { documentDecision } from "./fairqueue.js";

// FINAL fmc_hw 2.3: a temp approval queue per test, and a person approving the queued request in the pane.
// Never the real %APPDATA% Revit.ini or HKCU: readIni/iniPath point at temp files and writePreference is injected.
function tempEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-hw-env-"));
  return { APPDATA: dir, LOCALAPPDATA: dir };
}
function personApproves(env: NodeJS.ProcessEnv, kind: string, by = "Emlyn"): string[] {
  const ids = readQueue(env).filter((item) => item.command === kind && item.status === "pending").map((item) => item.id);
  for (const id of ids) setStatus(id, "approved", by, env);
  return ids;
}
function tempIni(text: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-hw-ini-"));
  const file = path.join(dir, "Revit.ini");
  fs.writeFileSync(file, text, "utf8");
  return { dir, file };
}
const baks = (dir: string) => fs.readdirSync(dir).filter((name) => name.endsWith(".bak"));
const OPEN = { stopAi: () => false };

const NOW = Date.parse("2026-11-22T00:00:00Z");

function fixture(): HostRaw {
  return {
    platform: "win32",
    token: "must-not-leak",
    adapters: [
      { name: "Intel(R) UHD Graphics", vendor: "Intel", wmi_ram_bytes: 1073741824, dxgi_dedicated_bytes: 134217728, driver_version: "31.0.101.1", driver_date: "2023-01-15", luid: "0x111" },
      { name: "NVIDIA RTX A2000", vendor: "NVIDIA", wmi_ram_bytes: 4293918720, dxgi_dedicated_bytes: 6442450944, driver_version: "32.0.15.6094", driver_date: "2026-06-01", luid: "0x222" },
    ],
    memory: { total_mb: 32768, free_mb: 2048, source: "cim" },
    pagefiles: [{ name: "D:\\pagefile.sys", allocated_mb: 2048, current_mb: 1800, initial_mb: 2048, maximum_mb: 4096 }],
    disks: [{ drive: "C:", free_mb: 80000, total_mb: 200000 }, { drive: "D:", free_mb: 4000, total_mb: 100000 }],
    cpu: { name: "Test CPU", cores: 8, logical: 16 },
    processes: [{ pid: 4242, path: "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe", working_set_bytes: 6000 * 1048576, private_bytes: 8000 * 1048576, commit_bytes: 9000 * 1048576 }],
    gpu_engines: [{ pid: 4242, luid: "0x111", dedicated_bytes: 256 * 1048576 }],
    video_memory: [{ luid: "0x222", current_usage_bytes: 1500 * 1048576, budget_bytes: 6000 * 1048576 }],
    gpu_preference: { exe: "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe", value: "GpuPreference=1;" },
  };
}

test("a scan prefers DXGI VRAM, flags the integrated GPU, and drops a token", () => {
  const scan = parseHost(fixture());
  assert.equal(JSON.stringify(scan).includes("must-not-leak"), false);
  assert.equal(scan.gpus[0].dedicated_vram_mb, 128);
  assert.equal(scan.gpus[0].vram_source, "dxgi");
  assert.equal(scan.gpus[0].kind, "integrated");
  assert.equal(scan.gpus[1].dedicated_vram_mb, 6144);
  assert.equal(scan.gpus[1].kind, "dedicated");
  assert.equal(scan.revit[0].working_set_mb, 6000);
  assert.equal(scan.revit[0].private_mb, 8000);
  assert.equal(scan.revit[0].commit_mb, 9000);
  assert.equal(scan.revit_vram.dedicated_mb, 256);
  assert.equal(scan.revit_gpu.on_integrated_while_dedicated_exists, true);
  assert.equal(scan.gpu_preference.parsed, "power_saving");
  assert.equal(scan.cpu.cores, 8);
  assert.equal(scan.page_files[0].drive, "D:");
  assert.ok(scan.honesty.some((line) => /cannot replace/.test(line) || /does not hold/.test(line)));
});

test("advice names a small page file, a full page-file drive, an old driver, and the integrated GPU", () => {
  const scan = parseHost(fixture());
  scan.graphics = readGraphics("[Graphics]\r\nUseHardwareAcceleration=0\r\nAntialiasing=0\r\n", "test");
  const items = advise(scan, NOW);
  const ids = items.map((item) => item.id);
  assert.ok(ids.includes("cpu_and_ram"));
  assert.ok(ids.includes("pagefile_small"));
  assert.ok(ids.includes("pagefile_disk"));
  assert.ok(ids.includes("driver_old"));
  assert.ok(ids.includes("integrated_gpu"));
  assert.ok(ids.includes("hardware_acceleration"));
  for (const item of items) assert.ok(item.effect.length > 10, item.id);
  assert.equal(parseDriverDate("/Date(1717200000000)/")?.length, 10);
  assert.equal(parseDriverDate("20240601000000.000000+000"), "2024-06-01");
});

test("gpu_prefer is a dry run until confirm, needs a person's approval, and never writes Revit.ini", async () => {
  let wrote = "";
  const env = tempEnv();
  const io = {
    collect: async () => fixture(),
    readIni: () => "untouched",
    writePreference: (_exe: string, value: string) => { wrote = value; },
    config: { ...DEFAULT_CONFIG } as GuardConfig,
    env, ...OPEN,
  };
  const dry = JSON.parse((await runFmcHw({ action: "gpu_prefer" }, io)).content[0].text);
  assert.equal(dry.applied, false);
  assert.equal(wrote, "");
  assert.match(dry.revit_ini, /not changed/);
  assert.equal(readQueue(env).length, 0, "a dry run creates no approval");
  const refused = await runFmcHw({ action: "gpu_prefer", dry_run: false }, io);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /FMC-HW-CONFIRM/);
  assert.equal(wrote, "");
  const unapproved = await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true }, io);
  assert.match(unapproved.content[0].text, /FMC-HW-APPROVAL/);
  assert.equal(wrote, "");
  assert.equal(personApproves(env, "hw_gpu_prefer").length, 1);
  const applied = JSON.parse((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true }, io)).content[0].text);
  assert.equal(applied.applied, true);
  assert.equal(wrote, "GpuPreference=2;");
  assert.match(applied.revit_ini, /not changed/);
  assert.equal(applied.approval.by, "Emlyn");
});

test("offload reports graphics and writes them only with confirm and a person's approval", async () => {
  const { dir, file } = tempIni("[Graphics]\r\nUseHardwareAcceleration=0\r\nAntialiasing=0\r\n");
  const env = tempEnv();
  const io = {
    collect: async () => fixture(), iniPath: file, gpuRunner: null,
    revit: async () => ({ graphics: null }),
    config: { ...DEFAULT_CONFIG } as GuardConfig, env, ...OPEN,
  };
  const planned = JSON.parse((await runFmcHw({ action: "offload" }, io)).content[0].text);
  assert.equal(planned.applied, false);
  assert.equal(planned.graphics.use_hardware_acceleration, "0");
  assert.match(planned.graphics.view_hardware_note, /does not invent/);
  assert.ok(planned.cannot_move.some((line: string) => /model database/.test(line)));
  assert.equal(planned.view_export.moved_to_gpu, false);
  assert.match(planned.view_export.note, /API/);
  const refused = await runFmcHw({ action: "offload", dry_run: false }, io);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /FMC-HW-CONFIRM/);
  assert.match((await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io)).content[0].text, /FMC-HW-APPROVAL/);
  personApproves(env, "hw_offload");
  const applied = JSON.parse((await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io)).content[0].text);
  assert.equal(applied.applied, true, JSON.stringify(applied));
  const next = readGraphics(fs.readFileSync(file, "utf8"), "after");
  assert.equal(next.use_hardware_acceleration, "1");
  assert.equal(next.antialiasing, "1");
  assert.equal(next.optimize_view_navigation, "1");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ini edits keep neighbouring keys", () => {
  const text = "[Graphics]\r\nUseHardwareAcceleration=0\r\nSomeOther=keep\r\n[Other]\r\nA=1\r\n";
  const plan = graphicsPlan(readGraphics(text, "t"));
  const next = applyGraphicsText(text, plan.writes);
  assert.match(next, /SomeOther=keep/);
  assert.match(next, /\[Other\]/);
  assert.match(next, /A=1/);
  assert.equal(upsertIni(text, "Graphics", "UseHardwareAcceleration", "1").includes("SomeOther=keep"), true);
});

test("the ray and clash kernels hit and miss, and a GPU mismatch stays on the CPU", () => {
  const box = [0, 0, 0, 10, 10, 10];
  assert.equal(rayHitsAabb([0, 0, -10], [0, 0, 1], box), true);
  assert.equal(rayHitsAabb([0, 0, -10], [0, 1, 0], box), false);
  assert.equal(rayVoxelHits([{ origin: [0, 0, -10], direction: [0, 0, 1] }], [box]), 1);
  assert.deepEqual(clashPairs([box, [5, 5, 5, 12, 12, 12], [100, 100, 100, 110, 110, 110]]), [[0, 1]]);
  const match: GpuRunner = { id: "directml", available: true, detail: "test", run: (_kind, cpu) => cpu };
  const used = dispatchJob("trace_clash", () => clashPairs([box, [5, 5, 5, 12, 12, 12]]), match, true);
  assert.equal(used.backend, "directml");
  assert.equal(used.moved_to_gpu, true);
  const mismatch: GpuRunner = { id: "directcompute", available: true, detail: "bad", run: () => ({ no: true }) };
  const kept = dispatchJob("trace_clash", () => clashPairs([box, box]), mismatch, true);
  assert.equal(kept.backend, "cpu");
  assert.equal(kept.moved_to_gpu, false);
  assert.match(kept.fallback ?? "", /discarded/);
  const noGpu = dispatchJob("pressure_test", () => 1, null, false);
  assert.equal(noGpu.backend, "cpu");
  assert.match(noGpu.fallback ?? "", /CPU/);
});

test("free never closes the last view, skips a person unless the pause is on, and does not add a save", () => {
  const doc = {
    title: "Tower",
    path: "C:\\WIP\\Tower.rvt",
    active: true,
    person_working: true,
    open_views: [
      { id: "1", name: "Level 1", active: true, pinned: false },
      { id: "2", name: "3D", active: false, pinned: false },
      { id: "3", name: "Sheet", active: false, pinned: true },
      { id: "4", name: "Section", active: false, pinned: false },
    ],
  };
  const quiet = planFree({ documents: [doc], keep: 2, memory_pause: false, purge_undo: true, autosave_due: () => true });
  assert.equal(quiet.close.length, 0);
  assert.match(quiet.skipped[0].reason, /person is working/);
  const paused = planFree({ documents: [{ ...doc, person_working: true }], keep: 2, memory_pause: true, purge_undo: true, autosave_due: () => true });
  assert.ok(paused.close.some((row) => row.view_id === "4") || paused.close.some((row) => row.view_id === "2"));
  assert.ok(!paused.close.some((row) => row.view_id === "1"));
  assert.ok(!paused.close.some((row) => row.view_id === "3"));
  assert.equal(paused.saves.length, 0);
  assert.match(paused.save_skipped[0].reason, /not an extra save|undo/);
  const only = planFree({
    documents: [{ ...doc, person_working: false, open_views: [{ id: "1", name: "Only", active: true, pinned: false }] }],
    keep: 1, memory_pause: false, purge_undo: true, autosave_due: () => false,
  });
  assert.equal(only.close.length, 0);
  assert.match(only.save_skipped[0].reason, /would not save/);
  const due = planFree({
    documents: [{ ...doc, person_working: false }],
    keep: 2, memory_pause: false, purge_undo: true, autosave_due: () => true,
  });
  assert.equal(due.saves.length, 1);
  const cfg = { ...DEFAULT_CONFIG, ai_modeller: { auto_save_minutes: 10, mode: "testing" } } as GuardConfig;
  assert.equal(autosaveWouldSave({ title: "Tower", path: "C:\\WIP\\Tower.rvt" }, cfg, NOW, NOW), false);
  assert.equal(autosaveWouldSave({ title: "Tower", path: "C:\\WIP\\Tower.rvt" }, cfg, NOW, NOW - 11 * 60_000), true);
  assert.equal(autosaveWouldSave({ title: "Fam", path: "C:\\WIP\\Fam.rfa", family: true }, cfg, NOW, null), false);
});

test("scan and health expose the cache and do not print a token", async () => {
  await primeHardwareScan({ collect: async () => fixture(), readIni: () => "[Graphics]\r\nUseHardwareAcceleration=1\r\n" });
  const body = await healthReport("revit-bridge", Date.now());
  assert.equal(body.hw.status, "ready");
  assert.equal(body.hw.gpus.length, 2);
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  assert.equal(typeof body.memory.tier, "string");
  const scan = JSON.parse((await runFmcHw({ action: "scan" }, { collect: async () => fixture(), readIni: () => null, revit: async () => { throw new Error("revit closed"); } })).content[0].text);
  assert.equal(scan.gpus.length, 2);
  assert.ok(Array.isArray(scan.advice));
  const stripped = stripSecrets({ token: "abc", name: "gpu" });
  assert.equal("token" in stripped, false);
});

test("HW-T07: dry runs write nothing, back up nothing, call no preference writer and create no approval", async () => {
  const text = "[Graphics]\r\nUseHardwareAcceleration=0\r\n";
  const { dir, file } = tempIni(text);
  const env = tempEnv();
  const io = {
    collect: async () => fixture(), iniPath: file, gpuRunner: null,
    writePreference: () => { assert.fail("the preference writer must not run on a dry run"); },
    revit: async (action: string) => action === "memory" ? { documents: [{ title: "T", path: "C:\\WIP\\T.rvt", person_working: false, open_views: [
      { id: "1", name: "a", active: true, pinned: false }, { id: "2", name: "b", active: false, pinned: false }, { id: "3", name: "c", active: false, pinned: false }] }] } : {},
    revitWrite: async () => { assert.fail("no gated write on a dry run"); },
    config: { ...DEFAULT_CONFIG } as GuardConfig, env, stopAi: () => true, leaseDocuments: () => [],
  };
  for (const action of ["gpu_prefer", "offload", "free"] as const) {
    const body = JSON.parse((await runFmcHw({ action }, io)).content[0].text);
    assert.equal(body.applied, false, action);
  }
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(baks(dir), []);
  assert.equal(readQueue(env).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("HW-T08: a real free, gpu_prefer or offload without confirm is FMC-HW-CONFIRM and writes nothing", async () => {
  const text = "[Graphics]\r\nUseHardwareAcceleration=0\r\n";
  const { dir, file } = tempIni(text);
  let wrote = false;
  const io = {
    collect: async () => fixture(), iniPath: file, gpuRunner: null,
    writePreference: () => { wrote = true; },
    revit: async () => ({ documents: [] }),
    revitWrite: async () => { wrote = true; return {}; },
    config: { ...DEFAULT_CONFIG } as GuardConfig, env: tempEnv(), ...OPEN,
  };
  for (const action of ["gpu_prefer", "offload", "free"] as const) {
    for (const confirm of [undefined, false]) {
      const out = await runFmcHw({ action, dry_run: false, confirm, document: "T" }, io);
      assert.equal(out.isError, true, action);
      assert.match(out.content[0].text, /FMC-HW-CONFIRM/, action);
    }
  }
  assert.equal(wrote, false);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(baks(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("HW-T09 / A3 / A4: no approval, a spent id, a changed ini hash, or a non-person record is FMC-HW-APPROVAL", async () => {
  const text = "[Graphics]\r\nUseHardwareAcceleration=0\r\n";
  const { dir, file } = tempIni(text);
  const env = tempEnv();
  let wrote = 0;
  const io = {
    collect: async () => fixture(), iniPath: file, gpuRunner: null,
    writePreference: () => { wrote++; },
    config: { ...DEFAULT_CONFIG } as GuardConfig, env, ...OPEN,
  };
  const real = { dry_run: false, confirm: true } as const;
  // none
  assert.match((await runFmcHw({ action: "offload", ...real }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.match((await runFmcHw({ action: "gpu_prefer", ...real }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.equal(wrote, 0);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(baks(dir), []);
  // AI-minted or testing auto-approve: the approver is empty or "auto..."
  personApproves(env, "hw_gpu_prefer", "auto-approved (testing)");
  assert.match((await runFmcHw({ action: "gpu_prefer", ...real }, io)).content[0].text, /not given by a person/);
  personApproves(env, "hw_offload", "");
  assert.match((await runFmcHw({ action: "offload", ...real }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.equal(wrote, 0);
  // a changed ini after the person approved: a different record, so refused
  for (const item of readQueue(env).filter((row) => row.command === "hw_offload")) setStatus(item.id, "approved", "Emlyn", env);
  fs.writeFileSync(file, text + "; edited\r\n", "utf8");
  assert.match((await runFmcHw({ action: "offload", ...real }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.equal(fs.readFileSync(file, "utf8"), text + "; edited\r\n");
  assert.deepEqual(baks(dir), []);
  // used once, then spent
  for (const item of readQueue(env).filter((row) => row.command === "hw_gpu_prefer")) setStatus(item.id, "approved", "Emlyn", env);
  assert.equal(JSON.parse((await runFmcHw({ action: "gpu_prefer", ...real }, io)).content[0].text).applied, true);
  assert.equal(wrote, 1);
  const used = readQueue(env).find((row) => row.command === "hw_gpu_prefer");
  assert.equal(used?.status, "used");
  assert.equal(used?.by, "Emlyn", "the approver stays on the used record");
  assert.match((await runFmcHw({ action: "gpu_prefer", ...real }, io)).content[0].text, /already used once/);
  assert.equal(wrote, 1);
  // expired
  const env2 = tempEnv();
  const later = { ...io, env: env2, now: () => Date.now() + 31 * 60_000 };
  await runFmcHw({ action: "gpu_prefer", ...real }, { ...io, env: env2 });
  personApproves(env2, "hw_gpu_prefer");
  assert.match((await runFmcHw({ action: "gpu_prefer", ...real }, later)).content[0].text, /expired/);
  assert.equal(wrote, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("HW-T11 / A6: offload backs up to Revit.ini.<stamp>.bak with the old bytes, then replaces the file atomically", async () => {
  const old = "[Graphics]\r\nUseHardwareAcceleration=0\r\nAntialiasing=0\r\n[Other]\r\nKeep=me\r\n";
  const { dir, file } = tempIni(old);
  fs.writeFileSync(path.join(dir, "Revit.ini.bak"), "bare backup", "utf8");
  const env = tempEnv();
  const io = { collect: async () => fixture(), iniPath: file, gpuRunner: null, config: { ...DEFAULT_CONFIG } as GuardConfig, env, ...OPEN };
  await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io);
  personApproves(env, "hw_offload");
  const body = JSON.parse((await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io)).content[0].text);
  assert.equal(body.applied, true);
  assert.match(body.backup, /Revit\.ini\.\d{8}-\d{6}\.bak$/);
  assert.equal(fs.readFileSync(body.backup, "utf8"), old);
  assert.equal(fs.readFileSync(path.join(dir, "Revit.ini.bak"), "utf8"), "bare backup", "the bare Revit.ini.bak is never overwritten");
  const now = fs.readFileSync(file, "utf8");
  assert.equal(readGraphics(now, "after").use_hardware_acceleration, "1");
  assert.match(now, /\[Other\]\r?\nKeep=me/);
  assert.equal(fs.existsSync(file + ".tmp"), false);
  assert.match(body.takes_effect, /next Revit start/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("HW-T12 / A6: a failed backup or replace is FMC-HW-BACKUP and leaves the live file as it was", async () => {
  const old = "[Graphics]\r\nUseHardwareAcceleration=0\r\n";
  const { dir, file } = tempIni(old);
  const real = fs as unknown as IniFs;
  const noCopy: IniFs = { ...real, existsSync: (p) => fs.existsSync(p), copyFileSync: () => { throw new Error("disk full"); }, writeFileSync: (p, x, e) => fs.writeFileSync(p, x, e), renameSync: (a, b) => fs.renameSync(a, b) };
  assert.throws(() => writeIniAtomic(file, "new", new Date(), noCopy), /FMC-HW-BACKUP/);
  assert.equal(fs.readFileSync(file, "utf8"), old);
  const noRename: IniFs = { existsSync: (p) => fs.existsSync(p), copyFileSync: (a, b) => fs.copyFileSync(a, b), writeFileSync: (p, x, e) => fs.writeFileSync(p, x, e), renameSync: () => { throw new Error("locked"); }, rmSync: (p, o) => fs.rmSync(p, o) };
  assert.throws(() => writeIniAtomic(file, "new", new Date(), noRename), /FMC-HW-BACKUP.*backup .* is kept/);
  assert.equal(fs.readFileSync(file, "utf8"), old);
  assert.equal(baks(dir).length, 1, "the .bak that was written is kept");
  assert.equal(fs.existsSync(file + ".tmp"), false);
  // through the tool: the reply is FMC-HW-BACKUP and the approval is not used
  const env = tempEnv();
  const io = { collect: async () => fixture(), iniPath: file, iniFs: noCopy, gpuRunner: null, config: { ...DEFAULT_CONFIG } as GuardConfig, env, ...OPEN };
  await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io);
  personApproves(env, "hw_offload");
  const out = await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io);
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /FMC-HW-BACKUP/);
  assert.equal(fs.readFileSync(file, "utf8"), old);
  assert.equal(readQueue(env).find((row) => row.command === "hw_offload")?.status, "approved", "not marked used after a failed write");
  // a missing file is FMC-HW and writes nothing
  assert.throws(() => writeIniAtomic(path.join(dir, "nope.ini"), "x"), /\[FMC-HW\] Revit\.ini was not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("free needs confirm, one document, Stop AI off, the lease and a person's approval, then goes through the gated write (HW-T10 / A2 / A5)", async () => {
  const docs = [
    { title: "Tower", path: "C:\\WIP\\Tower.rvt", person_working: false, open_views: [
      { id: "1", name: "L1", active: true, pinned: false }, { id: "2", name: "3D", active: false, pinned: false },
      { id: "3", name: "S", active: false, pinned: false }, { id: "4", name: "E", active: false, pinned: false }] },
    { title: "Annex", path: "C:\\WIP\\Annex.rvt", person_working: false, open_views: [
      { id: "7", name: "L1", active: true, pinned: false }, { id: "8", name: "3D", active: false, pinned: false },
      { id: "9", name: "S", active: false, pinned: false }] },
  ];
  const raw: string[] = [];
  const writes: Array<{ command: string; body: Record<string, unknown> }> = [];
  const env = tempEnv();
  let stopped = false;
  let held: string[] = ["C:\\WIP\\Tower.rvt"];
  let lock: string | null = null;
  const io = {
    revit: async (action: string) => { raw.push(action); return { documents: docs }; },
    revitWrite: async (command: string, body: Record<string, unknown>) => {
      if (lock) throw new Error(lock);
      writes.push({ command, body }); return { closed: [] };
    },
    config: { ...DEFAULT_CONFIG } as GuardConfig, env,
    stopAi: () => stopped, leaseDocuments: () => held,
  };
  const noConfirm = await runFmcHw({ action: "free", dry_run: false }, io);
  assert.equal(noConfirm.isError, true);
  assert.match(noConfirm.content[0].text, /FMC-HW-CONFIRM/);
  const noDoc = await runFmcHw({ action: "free", dry_run: false, confirm: true }, io);
  assert.equal(noDoc.isError, true);
  assert.match(noDoc.content[0].text, /FMC-DOC-REQUIRED/);
  const missing = await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "Nope" }, io);
  assert.match(missing.content[0].text, /Nope is not open/);
  // no approval yet: queued for the pane, nothing closed
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.equal(personApproves(env, "hw_free").length, 1);
  // Stop AI on, then no covering lease, then a live-model lock refusal: each refuses and closes nothing
  stopped = true;
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text, /Stop AI is on/);
  stopped = false;
  held = ["C:\\WIP\\Annex.rvt"];
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text, /FMC-BATCH-LOCKED/);
  held = [];
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text, /FMC-BATCH-LOCKED/);
  held = ["C:\\WIP\\Tower.rvt"];
  lock = "FMC live-model lock: Tower is a live project model. Refusing the change.";
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text, /live-model lock/);
  lock = null;
  assert.equal(writes.length, 0);
  assert.equal(readQueue(env).find((row) => row.command === "hw_free")?.status, "approved", "refusals never spend the approval");
  assert.ok(raw.every((action) => action === "memory"), "only the memory read goes raw; free never does");
  const done = JSON.parse((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text);
  assert.equal(done.applied, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command, "fmc_hw_free");
  assert.equal(writes[0].body.document, "C:\\WIP\\Tower.rvt");
  const close = writes[0].body.close as Array<{ document: string }>;
  assert.ok(close.length > 0);
  assert.ok(close.every((row) => row.document === "C:\\WIP\\Tower.rvt"), "only the named document's views");
  assert.equal(readQueue(env).find((row) => row.command === "hw_free")?.status, "used");
  // a second call is refused: single use
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text, /already used once/);
  assert.equal(writes.length, 1);
  // a changed plan (keep 1) is a different record
  assert.match((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 1 }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.equal(writes.length, 1);
});

test("gpu_prefer and offload with a project open need the document, the lease and the gate-only write fmc_hw_host", async () => {
  const docs = [
    { title: "Tower", path: "C:\\WIP\\Tower.rvt", person_working: false, open_views: [] },
    { title: "Annex", path: "C:\\WIP\\Annex.rvt", person_working: false, open_views: [] },
  ];
  const env = tempEnv();
  let wrote = 0;
  const gates: Array<{ command: string; body: Record<string, unknown> }> = [];
  const io = {
    collect: async () => fixture(), writePreference: () => { wrote++; },
    revit: async () => ({ documents: docs }),
    revitWrite: async (command: string, body: Record<string, unknown>) => { gates.push({ command, body }); return { gated: true }; },
    config: { ...DEFAULT_CONFIG } as GuardConfig, env, stopAi: () => false, leaseDocuments: () => ["C:\\WIP\\Tower.rvt"],
  };
  assert.match((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true }, io)).content[0].text, /FMC-DOC-REQUIRED/);
  assert.match((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true, document: "Annex" }, io)).content[0].text, /FMC-BATCH-LOCKED/);
  assert.equal(gates.length, 0);
  assert.match((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true, document: "Tower" }, io)).content[0].text, /FMC-HW-APPROVAL/);
  assert.deepEqual(gates.map((row) => [row.command, row.body.document]), [["fmc_hw_host", "C:\\WIP\\Tower.rvt"]]);
  personApproves(env, "hw_gpu_prefer");
  assert.equal(JSON.parse((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true, document: "Tower" }, io)).content[0].text).applied, true);
  assert.equal(wrote, 1);
  const refusing = { ...io, revitWrite: async () => { throw new Error("AI-assisted modeller: changing this PC's graphics settings is people-only."); } };
  assert.equal((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true, document: "Tower" }, refusing)).isError, true);
  assert.equal(wrote, 1);
});

test("fmc_hw_free is a gated write, people-only for AI below full access, and never waits on the memory hold", async () => {
  assert.equal(WRITE_COMMANDS.has("fmc_hw_free"), true);
  assert.equal(WRITE_COMMANDS.has("fmc_hw"), false, "scan, memory and advice stay reads");
  assert.ok(NEVER.fmc_hw_free);
  const hard = new MemoryGate(() => ({ freeMb: 100, totalMb: 16000, revitWorkingSetMb: 4000, source: "os" }), () => memoryLimits(1024), () => {}, 0);
  assert.equal(hard.view().tier, "hard");
  await admitWrite(hard, "fmc_hw_free", {}, 0);
  await admitWrite(hard, "fmc_hw_host", {}, 0);
  await assert.rejects(() => admitWrite(hard, "create_level", {}, 0), /FMC-RAM-PAUSE/);
});

test("auto free is on by default; hw_auto_free false turns it off", async () => {
  resetAutoFreeThrottle();
  let called = false;
  const result = await autoFreeIfHard({ config: { ...DEFAULT_CONFIG, hw_auto_free: false } as GuardConfig, idle: () => true, revit: async () => { called = true; return {}; } });
  assert.equal(result.ran, false);
  assert.match(result.reason, /hw_auto_free is false/);
  assert.equal(called, false);
  const on = await autoFreeIfHard({ config: { ...DEFAULT_CONFIG } as GuardConfig, memoryView: () => ({ pause_below_mb: 1024, tier: "hard", free_mb: 800 }), idle: () => true, log: () => {}, revit: async () => { called = true; return { documents: [] }; } });
  assert.equal(called, true, "no hw_auto_free key: it runs");
  assert.equal(on.ran, true);
  resetAutoFreeThrottle();
});

const twoDocs = () => {
  const views = (doc: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${doc}-${i}`, name: `V${i}`, active: i === 0, pinned: false }));
  return [
    { title: "A-0003", path: "C:\\WIP\\A-0003.rvt", active: true, person_working: true, open_views: views("a", 5) },
    { title: "S-0003", path: "C:\\WIP\\S-0003.rvt", active: false, person_working: false, open_views: views("s", 4) },
  ];
};

function autoIo(docs: ReturnType<typeof twoDocs>, calls: Array<{ action: string; body: Record<string, unknown> }>, lines: string[], mb: number[]) {
  return {
    config: { ...DEFAULT_CONFIG } as GuardConfig,
    memoryView: () => ({ pause_below_mb: 1024, tier: "hard", free_mb: mb.length > 1 ? mb.shift()! : mb[0] }),
    idle: () => true,
    log: (line: string) => lines.push(line),
    revit: async (action: string, body: Record<string, unknown>) => {
      calls.push({ action, body });
      if (action === "memory") return { documents: docs };
      const close = (body.close as Array<{ view_id: string }>) ?? [];
      return { closed: close.map((row) => ({ view_id: row.view_id })), skipped: [] };
    },
  };
}

test("HW-T01: fmc_hw is a session command, so two open projects and no name do not refuse it", () => {
  const open = [{ title: "A-0003", path: "C:\\WIP\\A-0003.rvt" }, { title: "S-0003", path: "C:\\WIP\\S-0003.rvt" }];
  const hw = documentDecision("fmc_hw", open, undefined);
  assert.equal(hw.ok, true);
  const other = documentDecision("create_level", open, undefined);
  assert.equal(other.ok, false);
  assert.match(String((other as { message?: string }).message), /FMC-DOC-REQUIRED/);
});

test("HW-T02 / HW-T06: with two documents the hard-tier auto free reaches the add-in once, and the notice and health carry it", async () => {
  resetAutoFreeThrottle();
  const docs = twoDocs();
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const result = await autoFreeIfHard(autoIo(docs, calls, lines, [700, 900]));
  assert.equal(result.ran, true, result.reason);
  assert.equal(result.documents_open, 2);
  assert.deepEqual(calls.map((c) => c.action), ["memory", "free"]);
  assert.equal(calls[0].body.document, undefined, "the snapshot names no document");
  const free = calls[1].body;
  assert.equal(free.dry_run, false);
  assert.equal(free.memory_pause, true);
  assert.equal(free.keep, 2);
  assert.deepEqual(free.saves, []);
  const planned = planFree({ documents: docs, keep: 2, memory_pause: true, purge_undo: false, autosave_due: () => false }).close;
  assert.deepEqual(free.close, planned);
  assert.ok(planned.some((row) => row.document === "C:\\WIP\\A-0003.rvt"), "hard tier: spare views in the active document close");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[FMC-HW-AUTO-FREE\]/);
  assert.match(lines[0], /documents_open: 2/);
  assert.match(lines[0], /free_mb before 700, after 900 \(\+200 MB\)/);
  assert.match(lines[0], /C:\\WIP\\A-0003\.rvt: V\d \(a-\d\)/);
  const notice = lastAutoFree();
  assert.equal(notice?.ran, true);
  assert.equal(notice?.documents_open, 2);
  assert.equal(notice?.views_closed, planned.length);
  assert.equal(notice?.free_mb_before, 700);
  assert.equal(notice?.free_mb_after, 900);
  const health = await healthReport("revit-bridge", Date.now());
  assert.deepEqual(health.last_auto_free, notice);
  assert.equal(JSON.stringify(health).includes("must-not-leak"), false);
  resetAutoFreeThrottle();
});

test("HW-T03: a refused snapshot does not start the cooldown; a successful free does", async () => {
  resetAutoFreeThrottle();
  const docs = twoDocs();
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const io = autoIo(docs, calls, lines, [700]);
  let fail = true;
  const flaky = { ...io, revit: async (action: string, body: Record<string, unknown>) => {
    if (action === "memory" && fail) { fail = false; throw new Error("[FMC-DOC-REQUIRED] Several documents are open."); }
    return io.revit(action, body);
  } };
  const first = await autoFreeIfHard(flaky);
  assert.equal(first.ran, false);
  assert.equal(lines.length, 0, "no document list, so no notice");
  const second = await autoFreeIfHard(flaky);
  assert.equal(second.ran, true, "the cooldown did not start on the refused snapshot");
  const third = await autoFreeIfHard(flaky);
  assert.equal(third.ran, false);
  assert.match(third.reason, /already ran in the last minute/);
  // a failure after the snapshot still writes the notice
  resetAutoFreeThrottle();
  lines.length = 0;
  const broken = { ...io, revit: async (action: string, body: Record<string, unknown>) => { if (action === "free") throw new Error("add-in busy"); return io.revit(action, body); } };
  const failed = await autoFreeIfHard(broken);
  assert.equal(failed.ran, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[FMC-HW-AUTO-FREE\] Auto free did not finish\. documents_open: 2\..*add-in busy/);
  assert.equal(lastAutoFree()?.ran, false);
  const again = await autoFreeIfHard(io);
  assert.equal(again.ran, true, "a failed free does not start the cooldown");
  resetAutoFreeThrottle();
});

test("HW-T04 / HW-T05: hard tier closes spare views in the active document; soft tier skips it and auto free does not run", async () => {
  const doc = { title: "Tower", path: "C:\\WIP\\Tower.rvt", active: true, person_working: true, open_views: [
    { id: "1", name: "Level 1", active: true, pinned: false }, { id: "2", name: "3D", active: false, pinned: false },
    { id: "3", name: "Sheet", active: false, pinned: true }, { id: "4", name: "Section", active: false, pinned: false }, { id: "5", name: "E", active: false, pinned: false }] };
  const hard = planFree({ documents: [doc], keep: 2, memory_pause: true, purge_undo: false, autosave_due: () => false });
  assert.ok(hard.close.length > 0);
  assert.ok(!hard.close.some((row) => row.view_id === "1" || row.view_id === "3"));
  const soft = planFree({ documents: [doc], keep: 2, memory_pause: false, purge_undo: false, autosave_due: () => false });
  assert.equal(soft.close.length, 0);
  assert.match(soft.skipped[0].reason, /person is working/);
  resetAutoFreeThrottle();
  const r = await autoFreeIfHard({ config: { ...DEFAULT_CONFIG } as GuardConfig, memoryView: () => ({ pause_below_mb: 1024, tier: "soft" }), idle: () => true, revit: async () => ({}) });
  assert.equal(r.ran, false);
  assert.match(r.reason, /only in the hard tier/);
});

test("HW-T13 / A7: auto free runs on the internal hook with Stop AI on, no lease and no approval, and creates no approval", async () => {
  resetAutoFreeThrottle();
  const env = tempEnv();
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const io = { ...autoIo(twoDocs(), calls, lines, [700]), env, stopAi: () => true, leaseDocuments: () => [] as string[] };
  const result = await autoFreeIfHard(io);
  assert.equal(result.ran, true);
  assert.equal(lines.length, 1);
  assert.equal(readQueue(env).length, 0);
  assert.ok(calls.every((c) => c.action === "memory" || c.action === "free"), "sendRaw fmc_hw only, never fmc_hw_free");
  resetAutoFreeThrottle();
});

test("HW-T14: fmc_hw stays a read; the real writes use the gate helpers and auto free does not", () => {
  assert.equal(WRITE_COMMANDS.has("fmc_hw"), false);
  assert.equal(WRITE_COMMANDS.has("fmc_hw_free"), true);
  assert.equal(WRITE_COMMANDS.has("fmc_hw_host"), true);
  assert.ok(NEVER.fmc_hw_host);
  const tool = fs.readFileSync(new URL("../tools/fmc_hw.js", import.meta.url), "utf8");
  for (const helper of ["stopRefusal(", "leaseRefusal(", "checkHwApproval(", "useHwApproval(", "\"fmc_hw_free\"", "\"fmc_hw_host\"", "writeIniAtomic("]) assert.ok(tool.includes(helper), helper);
  assert.equal(tool.includes("hw_host_writes"), false);
  const hw = fs.readFileSync(new URL("./hw.js", import.meta.url), "utf8");
  const auto = hw.slice(hw.indexOf("export async function autoFreeIfHard"), hw.indexOf("export function memoryReport"));
  for (const helper of ["checkHwApproval", "leaseRefusal", "stopRefusal", "fmc_hw_free", "revitWrite"]) assert.equal(auto.includes(helper), false, helper);
  // FINAL 3.4: the notice goes to the memory gate's service log, not a separate console call.
  assert.ok(auto.includes("serviceLog"));
  assert.equal(auto.includes("console.error"), false);
});
