import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aiGate } from "./aigate.js";
import { centralBusy, planSync, runDocumentSync, syncDocumentKey, syncSettings, syncSkip, type SyncFacts, type SyncTiming } from "./batchsync.js";
import { BatchBoard, documentKey } from "./batchline.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";

const settings = syncSettings({ sync_minutes: 15, sync_on_batch_end: true });
const open: SyncFacts = { workshared: true, stopAi: false, aiOn: true };
const base = (over: Partial<SyncTiming> = {}): SyncTiming => ({
  now: 1_000_000, lastSyncAt: null, changedAt: 900_000, leaseHeld: false, batchEnd: false, ...over,
});

test("sync settings default to 15 minutes and batch end, for every document", () => {
  assert.deepEqual(syncSettings(undefined), { minutes: 15, onBatchEnd: true, exclude: [], documents: null });
  assert.deepEqual(syncSettings({ sync_minutes: 0, sync_on_batch_end: false }), { minutes: 0, onBatchEnd: false, exclude: [], documents: null });
});

test("sync_exclude skips a document, and sync_documents is a per-document allowlist", () => {
  const path = "D:\\Projects\\HEBERT\\Structure.rvt";
  assert.equal(syncDocumentKey(path), documentKey(path));
  assert.equal(syncDocumentKey("Structure"), documentKey("D:/Projects/HEBERT/Structure.rvt"));
  const excluded = syncSettings({ sync_exclude: ["Architecture", path] });
  const arch = planSync(open, base({ now: 900_000 + 15 * 60_000 }), excluded, "Architecture");
  assert.equal(arch.run, false);
  assert.equal(arch.excluded, true);
  assert.match(arch.reason, /sync_exclude/);
  const byPath = syncSkip("Structure", excluded);
  assert.equal(byPath?.excluded, true);
  const only = syncSettings({ sync_documents: ["Structure"] });
  const structure = planSync(open, base({ now: 900_000 + 15 * 60_000, batchEnd: true }), only, "Structure");
  assert.equal(structure.run, true);
  assert.equal(structure.excluded, false);
  const plumbing = planSync(open, base({ now: 900_000 + 15 * 60_000, batchEnd: true }), only, "Plumbing");
  assert.equal(plumbing.run, false);
  assert.equal(plumbing.excluded, true);
  assert.match(plumbing.reason, /sync_documents/);
  const both = syncSettings({ sync_exclude: ["Structure"], sync_documents: ["Structure"] });
  assert.match(planSync(open, base({ batchEnd: true }), both, "D:\\Models\\Structure.rvt").reason, /sync_exclude/);
});

test("only a workshared model with AI on syncs, between batches or at batch end", () => {
  assert.equal(planSync({ ...open, workshared: false }, base(), settings).run, false);
  assert.match(planSync({ ...open, workshared: false }, base(), settings).reason, /Autosave only/);
  assert.equal(planSync({ ...open, stopAi: true, aiOn: false }, base({ batchEnd: true }), settings).run, false);
  assert.match(planSync({ ...open, stopAi: true }, base(), settings).reason, /Stop AI/);
  assert.match(planSync({ ...open, aiOn: false }, base(), settings).reason, /live-model lock/);
  assert.match(planSync({ ...open, protected: true }, base(), settings).reason, /Protected/);
  const early = planSync(open, base({ now: 900_000 + 60_000 }), settings);
  assert.equal(early.run, false);
  assert.ok(early.next_sync);
  const due = planSync(open, base({ now: 900_000 + 15 * 60_000 }), settings);
  assert.equal(due.run, true);
  assert.match(due.reason, /15 minutes/);
  const held = planSync(open, base({ now: 900_000 + 15 * 60_000, leaseHeld: true }), settings);
  assert.equal(held.run, false);
  assert.match(held.reason, /between batches/);
  const ended = planSync(open, base({ now: 901_000, batchEnd: true, leaseHeld: true }), settings);
  assert.equal(ended.run, true);
  assert.match(ended.reason, /Batch ended/);
  assert.equal(planSync(open, base({ changedAt: null, batchEnd: true }), settings).run, false);
});

test("a busy central retries and does not fail the batch; a lock refusal does not retry", async () => {
  assert.equal(centralBusy("central model is locked by another user"), true);
  assert.equal(centralBusy("Stop AI is on"), false);
  assert.equal(centralBusy("Live-model lock: Architecture is a project model"), false);
  const sleeps: number[] = [];
  let tries = 0;
  const saved = await runDocumentSync("Architecture", async (command, params) => {
    tries++;
    assert.equal(params.batch_sync, true);
    assert.equal(params.document, "Architecture");
    if (command === "fmc_revit_file" && params.action === "sync" && tries < 4) throw new Error("The central model is locked");
    if (params.action === "sync") assert.equal(params.relinquish, true);
    return { ok: true };
  }, { sleep: async (ms) => { sleeps.push(ms); }, delays: [10, 20, 30] });
  assert.equal(saved.synced, true);
  assert.equal(saved.ok, true);
  assert.deepEqual(sleeps, [10]);
  const refused = await runDocumentSync("Architecture", async () => { throw new Error("Stop AI is on"); }, { delays: [10, 20] });
  assert.equal(refused.synced, false);
  assert.equal(refused.ok, true);
  assert.match(refused.detail, /not failed/);
});

test("a failed sync does not fail the batch, and the lease is still held while it runs", async () => {
  let held = false;
  const made = new BatchBoard({
    autoSweep: false,
    log: () => {},
    syncStep: async () => {
      held = made.status().documents ? true : true;
      const status = made.snapshot();
      const doc = (status.documents as Array<{ holder: { lease: string } | null }>)[0];
      assert.ok(doc.holder, "the lease is held during sync");
      return { ran: true, ok: true, synced: false, detail: "Sync did not finish. The batch is not failed. central locked", error: "central locked" };
    },
  });
  const refs = { kit: ["k"], standards: ["s"], rulebook: ["r"] };
  const got = await made.request({ document: "Architecture", label: "grids", client: "a", references: refs });
  const released = await made.releaseWithCare(String(got.lease), "ok", "a", "done");
  assert.equal(held, true);
  assert.equal(released.outcome, "ok");
  const view = (made.snapshot().documents as Array<{ last_error: string | null; last_sync: string | null }>)[0];
  assert.equal(view.last_error, "central locked");
  assert.equal(view.last_sync, null);
  const row = (made.snapshot().syncs as Array<{ last_error: string | null }>)[0];
  assert.equal(row.last_error, "central locked");
});

test("batch sync is refused when Stop AI is on and does not ask for an approval", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sync-gate-"));
  const cfg = { ...DEFAULT_CONFIG, ai_modeller: { on: true, general: true, stop: true, mode: "testing", projects: {} } } as GuardConfig;
  const doc = { title: "P-F-V-00-M3-S-001", path: "C:\\P\\01_WIP\\P-F-V-00-M3-S-001.rvt", isFamily: false, isWorkshared: true, isLocal: true };
  const stopped = await aiGate("fmc_revit_file", { action: "sync", batch_sync: true }, doc, cfg, async () => ({}), { APPDATA: dir } as NodeJS.ProcessEnv);
  assert.equal(stopped.ok, false);
  assert.match(stopped.user ?? "", /stopped/i);
  const on = { ...cfg, ai_modeller: { on: true, general: true, stop: false, mode: "testing", projects: {} } } as GuardConfig;
  const allowed = await aiGate("fmc_revit_file", { action: "sync", batch_sync: true }, doc, on, async () => ({}), { APPDATA: dir } as NodeJS.ProcessEnv);
  assert.equal(allowed.ok, true);
  assert.equal(typeof allowed.run, "function");
});
