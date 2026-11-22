import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deferReason, loadSyncState, nextActionAt, pickOne, planTick, saveSyncState, seedModified, staggerOffsetMs, syncStatePath } from "./docschedule.js";
import { saveBlocked, saveSkipReason } from "./savepolicy.js";
import { imageDir, keptImagePath } from "./images.js";
import { DEFAULT_CONFIG } from "./policy.js";

const ogala = "D:\\Fomcraft\\FMC_PROJECTS_27\\THE OGALA RESIDENCE\\01_WIP\\S\\F26901-FMC-ZZ-ZZ-M3-S-0001.rvt";

test("defer reason is the first session-wide wait, and a clear session is null", () => {
  const clear = { queueBusy: false, leasesHeld: 0, modalDialog: false, memoryPaused: false, docBusy: false };
  assert.equal(deferReason(clear), null);
  const reason = (facts: Parameters<typeof deferReason>[0]) => deferReason(facts) ?? "";
  assert.match(reason({ ...clear, queueBusy: true }), /job is running or queued/);
  assert.match(reason({ ...clear, leasesHeld: 2 }), /every lease is released/);
  assert.match(reason({ ...clear, modalDialog: true }), /modal dialog/);
  assert.match(reason({ ...clear, memoryPaused: true }), /Memory pause/);
  assert.match(reason({ ...clear, docBusy: true }), /transaction/);
  assert.match(reason({ ...clear, queueBusy: true, docBusy: true }), /job is running/);
});

test("stagger offsets keep two documents off the same tick", () => {
  const interval = 90_000;
  assert.equal(staggerOffsetMs(0, 3, interval), 0);
  assert.equal(staggerOffsetMs(1, 3, interval), 30_000);
  assert.equal(staggerOffsetMs(2, 3, interval), 60_000);
  assert.equal(staggerOffsetMs(0, 1, interval), 0);
  const started = 1_000_000;
  const first = nextActionAt(null, started, interval, 0);
  const second = nextActionAt(null, started, interval, 30_000);
  assert.equal(second - first, 30_000);
  assert.equal(nextActionAt(first, started, interval, 0), first + interval);
});

test("one tick runs the earliest save, and a sync does not share that tick", () => {
  const now = 10_000;
  const chosen = pickOne([
    { kind: "sync", document: "A", at: 9_000 },
    { kind: "save", document: "B", at: 9_000 },
    { kind: "save", document: "C", at: 9_500 },
  ], now);
  assert.equal(chosen?.kind, "save");
  assert.equal(chosen?.document, "B");
  const tick = planTick({
    now: 1_000,
    startedAt: 1_000,
    docs: [
      { title: "A", path: "C:\\A.rvt" },
      { title: "B", path: "C:\\B.rvt", workshared: true },
    ],
    clocks: [],
    saveIntervalMs: 60_000,
    syncIntervalMs: 60_000,
    saveSkipped: () => false,
    syncSkipped: () => false,
  });
  assert.equal(tick?.document, "A");
  assert.equal(tick?.kind, "save");
  assert.equal(tick?.at, 1_000);
});

test("sync clocks round-trip and a modified open document is seeded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sync-state-"));
  const env = { ...process.env, APPDATA: dir } as NodeJS.ProcessEnv;
  const rows = [{ document: "Architecture", changedAt: 10, lastSyncAt: 4, lastSaveAt: 8, lastError: null }];
  saveSyncState(rows, env);
  assert.deepEqual(loadSyncState(env), rows);
  assert.equal(fs.existsSync(syncStatePath(env)), true);
  const seeded = seedModified(rows, [{ title: "Structure", path: "C:\\S.rvt", modified: true }, { title: "Architecture", modified: true }], 20);
  assert.equal(seeded.find((row) => row.document === "Structure")?.changedAt, 20);
  assert.equal(seeded.find((row) => row.document === "Architecture")?.changedAt, 10);
  assert.equal(loadSyncState({ ...env, APPDATA: path.join(dir, "missing") } as NodeJS.ProcessEnv).length, 0);
});

test("save_exclude matches like sync_exclude, and protected_paths is a prefix", () => {
  const cfg = { ...DEFAULT_CONFIG, save_exclude: ["F26901-FMC-ZZ-ZZ-M3-S-0001"], protected_paths: ["D:\\Fomcraft\\FMC_PROJECTS_27"], protected_roots: [] };
  assert.equal(saveBlocked({ title: "Other", path: "C:\\WIP\\Other.rvt" }, cfg), null);
  assert.match(saveBlocked({ title: "F26901-FMC-ZZ-ZZ-M3-S-0001", path: "C:\\WIP\\X.rvt" }, cfg) ?? "", /save_exclude/);
  assert.match(saveBlocked({ title: "S-0001", path: ogala }, { ...DEFAULT_CONFIG, protected_paths: ["D:\\Fomcraft"], protected_roots: [] }) ?? "", /protected path/);
  // The old check is protected_roots only. Empty matches nothing, so this WIP file is not protected.
  assert.equal(saveBlocked({ title: "S-0001", path: ogala }, { ...DEFAULT_CONFIG, protected_roots: [], protected_paths: [] }), null);
  assert.match(saveBlocked({ title: "S-0001", path: ogala }, { ...DEFAULT_CONFIG, protected_roots: ["D:\\Fomcraft"] }) ?? "", /protected path/);
});

test("sync_exclude HEBERT HOSTELS means HEBERT HOSTELS_USER is never autosaved", () => {
  const cfg = { ...DEFAULT_CONFIG, sync_exclude: ["HEBERT HOSTELS"], save_exclude: [], protected_paths: [], protected_roots: [] };
  const local = { title: "HEBERT HOSTELS_USER", path: "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt" };
  assert.equal(saveSkipReason(local, cfg), "excluded");
  assert.match(saveBlocked(local, cfg) ?? "", /sync_exclude/);
  assert.equal(saveBlocked({ title: "S-0001", path: "C:\\WIP\\S-0001.rvt" }, cfg), null);
  const due = planTick({
    now: 100_000,
    startedAt: 0,
    docs: [local, { title: "S-0001", path: "C:\\WIP\\S-0001.rvt" }],
    clocks: [],
    saveIntervalMs: 10_000,
    syncIntervalMs: 0,
    saveSkipped: (doc) => saveBlocked({ title: doc.title, path: doc.path }, cfg) != null,
    syncSkipped: () => true,
  });
  assert.equal(due?.document, "S-0001");
  assert.notEqual(due?.document, "HEBERT HOSTELS_USER");
});

test("image output stays off D: and off the model folder", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" } as NodeJS.ProcessEnv;
  assert.equal(imageDir({}, env), "C:\\Users\\me\\AppData\\Local\\Formcraft\\images");
  assert.equal(imageDir({ image_dir: "D:\\shots" }, env), "C:\\Users\\me\\AppData\\Local\\Formcraft\\images");
  assert.equal(imageDir({}, { LOCALAPPDATA: "D:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" } as NodeJS.ProcessEnv), "C:\\Users\\me\\agent-tools\\images");
  const dir = imageDir({}, env);
  assert.equal(keptImagePath("detail.png", dir), path.win32.join(dir, "detail.png"));
  assert.throws(() => keptImagePath("D:\\Fomcraft\\shot.png", dir), /on D:/);
  assert.throws(() => keptImagePath("D:\\Fomcraft\\Model.rvt\\shot.png", dir), /next to a model|on D:/);
});
