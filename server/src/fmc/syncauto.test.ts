import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aiGate } from "./aigate.js";
import { parseConfig } from "./aiuse.js";
import { resetBatchBoard } from "./batchline.js";
import { memoryGate } from "./memory.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { policySummary } from "../tools/fmc_ai.js";
import {
  appendSyncAutoLog, isDamageDialog, judgeDirectSync, readSyncAutoLog, recentDamage, syncAutoLogPath,
  type SyncAutoFacts, type SyncHost,
} from "./syncauto.js";

const local: SyncHost = {
  title: "F26001-FMC-ZZ-ZZ-M3-A-0001",
  path: "D:\\Projects\\F26001\\01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt",
  isFamily: false, isWorkshared: true, isLocal: true, isDetached: false, isLinked: false, readOnly: false,
};
const ai = parseConfig({
  on: true, stop: false, mode: "testing", auto_approve: true, auto_approve_sync: true,
  projects: { F26001: { general: true } },
})!;
const now = Date.parse("2026-11-11T06:00:00Z");

function facts(over: Partial<SyncAutoFacts> = {}): SyncAutoFacts {
  return {
    now, holder: null, caller: { client: "stdio" }, ramPaused: false, dialogs: [], damaged: [], exclude: [], protectedRoots: [],
    ...over,
  };
}

test("auto_approve_sync defaults off, and it is ignored until testing mode and auto_approve are both on", () => {
  const off = parseConfig({ on: true, mode: "testing", auto_approve: true });
  assert.equal(off?.auto_approve_sync, false);
  assert.equal(judgeDirectSync("sync", false, local, off, facts()).judged, false);
  const strict = parseConfig({ on: true, mode: "strict", auto_approve: true, auto_approve_sync: true, projects: { F26001: { general: true } } });
  const held = judgeDirectSync("sync", false, local, strict, facts());
  assert.equal(held.approve, false);
  assert.match(held.reason, /mode is testing and auto_approve is true/);
  const noAuto = parseConfig({ on: true, mode: "testing", auto_approve: false, auto_approve_sync: true, projects: { F26001: { general: true } } });
  assert.match(judgeDirectSync("sync", false, local, noAuto, facts()).reason, /auto_approve is true/);
});

test("a direct sync is auto-approved only when every check holds, and relinquish stays manual", () => {
  const yes = judgeDirectSync("sync", false, local, ai, facts());
  assert.equal(yes.approve, true);
  assert.match(yes.reason, /no other lease is active/);
  const held = judgeDirectSync("sync", false, local, ai, facts({ holder: { lease: "L1", client: "stdio" }, caller: { lease: "L1", client: "stdio" } }));
  assert.equal(held.approve, true);
  assert.match(held.reason, /this session holds the lease/);
  assert.equal(judgeDirectSync("relinquish", false, local, ai, facts()).judged, false);
  assert.equal(judgeDirectSync("sync", true, local, ai, facts()).judged, false);
});

test("each failed check refuses, with that reason", () => {
  const refuse = (over: Partial<SyncAutoFacts>, host: SyncHost = local) => judgeDirectSync("sync", false, host, ai, facts(over));
  assert.match(refuse({}, { ...local, isFamily: true }).reason, /family/i);
  assert.match(refuse({}, { ...local, isDetached: true }).reason, /detached/i);
  assert.match(refuse({}, { ...local, isLocal: false }).reason, /not a workshared local/i);
  assert.match(refuse({}, { ...local, isWorkshared: false, isLocal: true }).reason, /not a workshared local/i);
  assert.match(refuse({ protectedRoots: ["D:\\Projects\\F26001"] }).reason, /Protected original/);
  assert.match(refuse({ exclude: ["F26001-FMC-ZZ-ZZ-M3-A-0001"] }).reason, /sync_exclude/);
  assert.match(refuse({ holder: { lease: "other", client: "bob" }, caller: { lease: "L1", client: "stdio" } }).reason, /Another lease/);
  assert.match(refuse({ damaged: ["D:\\Projects\\F26001\\01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt"] }).reason, /damaged_documents/);
  assert.match(refuse({ ramPaused: true }).reason, /RAM gate is paused/);
  const stopped = parseConfig({ ...ai, stop: true, auto_approve_sync: true, auto_approve: true, mode: "testing" });
  assert.match(judgeDirectSync("sync", false, local, stopped, facts()).reason, /Stop AI/);
  const dark = parseConfig({ on: false, stop: false, mode: "testing", auto_approve: true, auto_approve_sync: true, projects: {} });
  assert.match(judgeDirectSync("sync", false, local, dark, facts()).reason, /AI is off/);
});

test("a recent corrupt-on-sync dialog flags that document, and an old one or another model's does not", () => {
  assert.equal(isDamageDialog("TaskDialog_Corrupt_Model_Detected_On_Synchronize_With_Central", ""), true);
  assert.equal(isDamageDialog("TaskDialog_Cannot_Keep_Joined", "Can't keep elements joined"), false);
  const fresh = { at: "2026-11-11T05:00:00Z", event: "dialog", dialog_id: "TaskDialog_Corrupt_Model_Detected_On_Synchronize_With_Central", message: "The model is corrupt", document: local.title };
  assert.match(recentDamage([fresh], local.title, local.path, now) ?? "", /flagged this document/);
  const unnamed = { at: "2026-11-11T05:30:00Z", event: "dialog", dialog_id: "TaskDialog_Model_Corrupt_On_Synchronize", message: "corrupt central" };
  assert.match(recentDamage([unnamed], local.title, local.path, now) ?? "", /does not name its document/);
  const old = { ...fresh, at: "2026-11-09T05:00:00Z" };
  assert.equal(recentDamage([old], local.title, local.path, now), null);
  const other = { ...fresh, document: "Structure" };
  assert.equal(recentDamage([other], local.title, local.path, now), null);
  assert.match(judgeDirectSync("sync", false, local, ai, facts({ dialogs: [fresh] })).reason, /corrupt-model dialog/);
});

test("every decision is appended, and fmc_ai status can read it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sync-log-"));
  const env = { APPDATA: dir } as NodeJS.ProcessEnv;
  appendSyncAutoLog(env, { at: "2026-11-11T06:00:00Z", document: local.title, decision: "refused", reason: "Another lease is active on this document." });
  appendSyncAutoLog(env, { at: "2026-11-11T06:01:00Z", document: local.title, decision: "approved", reason: "all checks passed" });
  const rows = readSyncAutoLog(env);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].decision, "approved");
  assert.ok(fs.existsSync(syncAutoLogPath(env)));
  const previous = process.env.APPDATA;
  process.env.APPDATA = dir;
  try {
    const status = policySummary({
      ...DEFAULT_CONFIG,
      ai_modeller: { on: true, mode: "testing", auto_approve: true, auto_approve_sync: true, projects: { F26001: { general: true } } },
    } as GuardConfig, local);
    assert.equal(status.sync_auto_approve.in_effect, true);
    assert.equal(status.sync_auto_approve.recent.length, 2);
    assert.equal(status.general.sync_auto_approve, true);
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  }
});

test("aigate auto-approves a direct sync when the checks pass, and leaves relinquish and a held document waiting", async () => {
  resetBatchBoard({ requiredReferences: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sync-gate-"));
  const env = { APPDATA: dir } as NodeJS.ProcessEnv;
  const cfg = {
    ...DEFAULT_CONFIG,
    protected_roots: ["D:\\Fomcraft\\Live"],
    damaged_documents: [],
    sync_exclude: [],
    ai_modeller: { on: true, stop: false, mode: "testing", auto_approve: true, auto_approve_sync: true, projects: { F26001: { general: true } } },
  } as GuardConfig;
  const sent: string[] = [];
  const send = async (command: string) => { sent.push(command); return {}; };
  const gate = await aiGate("fmc_revit_file", { action: "sync", document: local.path }, local, cfg, send, env);
  const log = readSyncAutoLog(env);
  if (memoryGate.leasesPaused()) {
    assert.equal(gate.ok, false);
    assert.match(String(log.at(-1)?.reason), /RAM gate is paused/);
    assert.equal(sent.length, 0);
  } else {
    assert.equal(gate.ok, true);
    assert.equal(log.at(-1)?.decision, "approved");
    await gate.run?.(async () => { sent.push("ran"); return { synced: true }; });
    assert.deepEqual(sent, ["ran"]);
  }
  const relinquish = await aiGate("fmc_revit_file", { action: "relinquish", document: local.path }, local, cfg, send, env);
  assert.equal(relinquish.ok, false);
  assert.equal(readSyncAutoLog(env).filter((row) => row.action === "relinquish").length, 0);

  const board = resetBatchBoard({ requiredReferences: [] });
  await board.request({ document: local.title, label: "other", client: "bob" });
  const blocked = await aiGate("fmc_revit_file", { action: "sync", document: local.path }, local, cfg, send, env);
  assert.equal(blocked.ok, false);
  assert.match(String(readSyncAutoLog(env).at(-1)?.reason), /Another lease/);
});
