import { test } from "node:test";
import assert from "node:assert/strict";
import { healthReport } from "./httpservice.js";
import { runFmcHw } from "../tools/fmc_hw.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  advise, applyGraphicsText, autoFreeIfHard, autosaveWouldSave, graphicsPlan, parseDriverDate, parseHost,
  planFree, primeHardwareScan, readGraphics, stripSecrets, upsertIni, writeIniWithBackup, type HostRaw,
} from "./hw.js";
import { clashPairs, dispatchJob, rayHitsAabb, rayVoxelHits, type GpuRunner } from "./hwgpu.js";
import { DEFAULT_CONFIG, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { resetAutoFreeThrottle } from "./hw.js";
import { NEVER } from "./aiuse.js";
import { MemoryGate, admitWrite, memoryLimits } from "./memory.js";

const HOST_WRITES = { ...DEFAULT_CONFIG, hw_host_writes: true } as GuardConfig;

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

test("gpu_prefer is a dry run until confirm, and it never writes Revit.ini", async () => {
  let wrote = "";
  let ini = "untouched";
  const io = {
    collect: async () => fixture(),
    readIni: () => ini,
    writeIni: (text: string) => { ini = text; },
    writePreference: (_exe: string, value: string) => { wrote = value; },
    config: HOST_WRITES,
  };
  const dry = JSON.parse((await runFmcHw({ action: "gpu_prefer" }, io)).content[0].text);
  assert.equal(dry.applied, false);
  assert.equal(wrote, "");
  assert.match(dry.revit_ini, /not changed/);
  const refused = await runFmcHw({ action: "gpu_prefer", dry_run: false }, io);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /FMC-HW-CONFIRM/);
  assert.equal(wrote, "");
  const applied = JSON.parse((await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true }, io)).content[0].text);
  assert.equal(applied.applied, true);
  assert.equal(wrote, "GpuPreference=2;");
  assert.equal(ini, "untouched");
  assert.match(applied.revit_ini, /not changed/);
});

test("offload reports graphics and writes them only with confirm", async () => {
  let ini = "[Graphics]\r\nUseHardwareAcceleration=0\r\nAntialiasing=0\r\n";
  const io = {
    collect: async () => fixture(),
    readIni: () => ini,
    writeIni: (text: string) => { ini = text; },
    gpuRunner: null,
    revit: async () => ({ graphics: null }),
    config: HOST_WRITES,
  };
  const planned = JSON.parse((await runFmcHw({ action: "offload" }, io)).content[0].text);
  assert.equal(planned.applied, false);
  assert.equal(planned.graphics.use_hardware_acceleration, "0");
  assert.match(planned.graphics.view_hardware_note, /does not invent/);
  assert.ok(planned.cannot_move.some((line: string) => /model database/.test(line)));
  assert.equal(planned.view_export.moved_to_gpu, false);
  assert.match(planned.view_export.note, /API/);
  assert.equal(ini.includes("UseHardwareAcceleration=0"), true);
  const refused = await runFmcHw({ action: "offload", dry_run: false }, io);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /FMC-HW-CONFIRM/);
  const applied = JSON.parse((await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io)).content[0].text);
  assert.equal(applied.applied, true);
  const next = readGraphics(ini, "after");
  assert.equal(next.use_hardware_acceleration, "1");
  assert.equal(next.antialiasing, "1");
  assert.equal(next.optimize_view_navigation, "1");
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

test("gpu_prefer and offload with confirm still refuse until a person turns on hw_host_writes", async () => {
  let wrote = "";
  let ini = "[Graphics]\r\nUseHardwareAcceleration=0\r\n";
  const io = {
    collect: async () => fixture(),
    readIni: () => ini,
    writeIni: (text: string) => { ini = text; },
    writePreference: (_exe: string, value: string) => { wrote = value; },
    gpuRunner: null,
    config: { ...DEFAULT_CONFIG } as GuardConfig,
  };
  const gpu = await runFmcHw({ action: "gpu_prefer", dry_run: false, confirm: true }, io);
  assert.equal(gpu.isError, true);
  assert.match(gpu.content[0].text, /FMC-HW-PERSON/);
  assert.equal(wrote, "");
  const off = await runFmcHw({ action: "offload", dry_run: false, confirm: true }, io);
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /FMC-HW-PERSON/);
  assert.equal(ini, "[Graphics]\r\nUseHardwareAcceleration=0\r\n");
  // the dry runs are unchanged
  assert.equal(JSON.parse((await runFmcHw({ action: "gpu_prefer" }, io)).content[0].text).applied, false);
});

test("Revit.ini is backed up to Revit.ini.bak before it is replaced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-hw-ini-"));
  const file = path.join(dir, "Revit.ini");
  assert.deepEqual(writeIniWithBackup(file, "first"), { backup: null });
  assert.equal(fs.readFileSync(file, "utf8"), "first");
  const second = writeIniWithBackup(file, "second");
  assert.equal(second.backup, `${file}.bak`);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), "first");
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("free needs confirm and one document, and a real free goes through the gated write (fmc_hw_free)", async () => {
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
  const io = {
    revit: async (action: string) => { raw.push(action); return { documents: docs }; },
    revitWrite: async (command: string, body: Record<string, unknown>) => { writes.push({ command, body }); return { closed: [] }; },
    config: { ...DEFAULT_CONFIG } as GuardConfig,
  };
  const noConfirm = await runFmcHw({ action: "free", dry_run: false }, io);
  assert.equal(noConfirm.isError, true);
  assert.match(noConfirm.content[0].text, /FMC-HW-CONFIRM/);
  const noDoc = await runFmcHw({ action: "free", dry_run: false, confirm: true }, io);
  assert.equal(noDoc.isError, true);
  assert.match(noDoc.content[0].text, /FMC-DOC-REQUIRED/);
  const missing = await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "Nope" }, io);
  assert.match(missing.content[0].text, /Nope is not open/);
  assert.equal(writes.length, 0);
  assert.ok(raw.every((action) => action === "memory"), "only the memory read goes raw; free never does");
  const done = JSON.parse((await runFmcHw({ action: "free", dry_run: false, confirm: true, document: "tower", keep: 2 }, io)).content[0].text);
  assert.equal(done.applied, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command, "fmc_hw_free");
  assert.equal(writes[0].body.document, "C:\\WIP\\Tower.rvt");
  const close = writes[0].body.close as Array<{ document: string }>;
  assert.ok(close.length > 0);
  assert.ok(close.every((row) => row.document === "C:\\WIP\\Tower.rvt"), "only the named document's views");
});

test("fmc_hw_free is a gated write, people-only for AI below full access, and never waits on the memory hold", async () => {
  assert.equal(WRITE_COMMANDS.has("fmc_hw_free"), true);
  assert.equal(WRITE_COMMANDS.has("fmc_hw"), false, "scan, memory and advice stay reads");
  assert.ok(NEVER.fmc_hw_free);
  const hard = new MemoryGate(() => ({ freeMb: 100, totalMb: 16000, revitWorkingSetMb: 4000, source: "os" }), () => memoryLimits(1024), () => {}, 0);
  assert.equal(hard.view().tier, "hard");
  await admitWrite(hard, "fmc_hw_free", {}, 0);
  await assert.rejects(() => admitWrite(hard, "create_level", {}, 0), /FMC-RAM-PAUSE/);
});

test("auto free stays off unless hw_auto_free is on", async () => {
  let called = false;
  const result = await autoFreeIfHard({ config: { ...DEFAULT_CONFIG } as GuardConfig, idle: () => true, revit: async () => { called = true; return {}; } });
  assert.equal(result.ran, false);
  assert.match(result.reason, /hw_auto_free/);
  assert.equal(called, false);
});

test("P-fmc_hw-02: with two or more documents open the hard-tier auto free still runs, names each document, and reports and logs it", async () => {
  resetAutoFreeThrottle();
  const views = (doc: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${doc}-${i}`, name: `V${i}`, active: i === 0, pinned: false }));
  const docs = [
    { title: "A-0003", path: "C:\\WIP\\A-0003.rvt", active: true, person_working: true, open_views: views("a", 5) },
    { title: "S-0003", path: "C:\\WIP\\S-0003.rvt", active: false, person_working: false, open_views: views("s", 4) },
    { title: "M-0003", path: "C:\\WIP\\M-0003.rvt", active: false, person_working: false, open_views: views("m", 1) },
  ];
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const lines: string[] = [];
  const result = await autoFreeIfHard({
    config: { ...DEFAULT_CONFIG, hw_auto_free: true } as GuardConfig,
    memoryView: () => ({ pause_below_mb: 1024, tier: "hard" }),
    idle: () => true,
    openDocuments: () => docs.map((d) => ({ title: d.title, path: d.path })),
    log: (line) => lines.push(line),
    revit: async (action, body) => {
      calls.push({ action, body });
      if (action === "memory") return { documents: docs };
      const close = (body.close as Array<{ view_id: string }>) ?? [];
      return { closed: close.map((row) => ({ document: body.document, view_id: row.view_id })), skipped: [] };
    },
  });
  assert.equal(result.ran, true, result.reason);
  assert.equal(result.documents_open, 3);
  assert.match(result.reason, /3 documents were open/);
  // every call names a document, so FMC-DOC-REQUIRED cannot stop it
  for (const call of calls) assert.ok(typeof call.body.document === "string" && call.body.document, call.action);
  const frees = calls.filter((c) => c.action === "free");
  assert.deepEqual(frees.map((c) => c.body.document), ["C:\\WIP\\A-0003.rvt", "C:\\WIP\\S-0003.rvt"]);
  for (const call of frees) {
    assert.equal(call.body.dry_run, false);
    assert.deepEqual(call.body.saves, []);
    for (const row of call.body.close as Array<{ document: string }>) assert.equal(row.document, call.body.document);
  }
  assert.deepEqual(result.freed?.map((row) => [row.document, row.closed]), [["C:\\WIP\\A-0003.rvt", 3], ["C:\\WIP\\S-0003.rvt", 2]]);
  assert.match(result.reason, /Closed 5 views/);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[FMC-HW-AUTOFREE\].*3 documents were open.*Closed 5 views/);
  // the opt-in is unchanged: off means nothing is read or closed, even with several documents open
  resetAutoFreeThrottle();
  calls.length = 0;
  const off = await autoFreeIfHard({ config: { ...DEFAULT_CONFIG } as GuardConfig, memoryView: () => ({ pause_below_mb: 1024, tier: "hard" }), idle: () => true, openDocuments: () => docs, revit: async (a, b) => { calls.push({ action: a, body: b }); return {}; } });
  assert.equal(off.ran, false);
  assert.equal(calls.length, 0);
  resetAutoFreeThrottle();
});
