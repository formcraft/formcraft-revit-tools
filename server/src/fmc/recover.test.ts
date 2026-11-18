import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchBoard } from "./batchline.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  applyRecovery, applyRefusal, buildRecoveryPlan, classifyInstance, HEBERT_ROLES, type ObservedInstance, type ObservedProcess, type RecoveryInput,
} from "./recover.js";

const NOW = Date.parse("2026-11-11T05:00:00.000Z");
const FRESH = new Date(NOW - 10_000).toISOString();
const STALE = new Date(NOW - 10 * 60_000).toISOString();

function revit(pid: number, extra: Partial<ObservedProcess> = {}): ObservedProcess {
  return { pid, name: "Revit.exe", responding: true, ...extra };
}

function inst(pid: number, updated = FRESH, port = 8080): ObservedInstance {
  return {
    pid, port, revit: "2025", updated,
    documents: [
      { title: "Architecture", path: "D:\\Fomcraft\\HEBERT\\Architecture.rvt", workshared: true },
      { title: "Door", path: "C:\\Fam\\Door.rfa", family: true },
    ],
  };
}

function input(over: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    now: NOW,
    heartbeatS: 90,
    processes: [revit(10)],
    instances: [inst(10)],
    portOpen: () => true,
    fileMtime: () => "2026-11-11T04:00:00.000Z",
    jobs: [],
    syncs: [],
    protectedRoots: ["D:\\Fomcraft"],
    documents: [],
    ...over,
  };
}

test("a responsive instance is healthy and is never closed; a dead, hung, or WerFault instance is not", () => {
  assert.equal(classifyInstance(inst(10), { now: NOW, heartbeatS: 90, processes: [revit(10)], portOpen: () => true }).health, "healthy");
  assert.equal(classifyInstance(inst(10), { now: NOW, heartbeatS: 90, processes: [revit(10)], portOpen: () => true }).close, false);
  const staleButUp = classifyInstance(inst(10, STALE), { now: NOW, heartbeatS: 90, processes: [revit(10)], portOpen: () => true });
  assert.equal(staleButUp.health, "healthy");
  assert.equal(staleButUp.close, false);
  assert.match(staleButUp.reasons.join(" "), /left alone/);
  assert.equal(classifyInstance(inst(10), { now: NOW, heartbeatS: 90, processes: [], portOpen: () => false }).health, "crashed");
  assert.equal(classifyInstance(inst(10), { now: NOW, heartbeatS: 90, processes: [revit(10, { responding: false })], portOpen: () => false }).health, "hung");
  const fault = classifyInstance(inst(10), { now: NOW, heartbeatS: 90, processes: [revit(10), { pid: 99, name: "WerFault.exe", commandLine: "WerFault -p 10" }], portOpen: () => true });
  assert.equal(fault.health, "crashed");
  assert.equal(fault.close, true);
  const silent = classifyInstance(inst(10, STALE), { now: NOW, heartbeatS: 90, processes: [revit(10)], portOpen: () => false });
  assert.equal(silent.health, "hung");
  assert.equal(silent.close, true);
});

test("plan reports title, path, workshared, save, sync, and the unsaved risk, and does not close a healthy Revit", () => {
  const plan = buildRecoveryPlan(input({
    jobs: [{ pid: 10, state: "running", command: "fmc_model_edit" }],
    syncs: [{ title: "Architecture", last_sync: "2026-11-11T03:00:00.000Z", next_sync: "2026-11-11T03:15:00.000Z" }],
  }));
  assert.deepEqual(plan.would_close, []);
  assert.deepEqual(plan.healthy_left_alone, [10]);
  const doc = plan.instances[0].documents[0];
  assert.equal(doc.title, "Architecture");
  assert.equal(doc.path, "D:\\Fomcraft\\HEBERT\\Architecture.rvt");
  assert.equal(doc.workshared, true);
  assert.equal(doc.open_as, "new_local_from_central");
  assert.equal(doc.last_sync, "2026-11-11T03:00:00.000Z");
  assert.equal(doc.last_save, "2026-11-11T04:00:00.000Z");
  assert.equal(doc.unsynced, true);
  assert.equal(doc.unsaved, true);
  assert.equal(doc.protected_original, true);
  assert.match(doc.risk, /may be lost/);
  assert.equal(plan.unsaved, true);
  assert.ok(plan.confirm);
  assert.ok(plan.needs_addin.length >= 3);
  assert.deepEqual([...HEBERT_ROLES], ["architecture", "structural", "electrical", "plumbing", "site"]);
});

test("a configured HEBERT list is what would be reopened, and apply refuses a bad token or unsaved work", async () => {
  const dead = input({
    processes: [],
    instances: [inst(10, STALE)],
    portOpen: () => false,
    jobs: [{ pid: 10, state: "running", command: "fmc_model_edit" }],
    documents: [
      { role: "architecture", title: "Architecture", path: "D:\\Fomcraft\\HEBERT\\Architecture.rvt", workshared: true },
      { role: "structural", path: "D:\\Fomcraft\\HEBERT\\Structural.rvt", workshared: true },
    ],
  });
  const plan = buildRecoveryPlan(dead);
  assert.equal(plan.reopen.length, 2);
  assert.equal(plan.reopen[0].open_as, "new_local_from_central");
  assert.match(applyRefusal(plan, {}) ?? "", /confirm token/);
  assert.match(applyRefusal(plan, { confirm: plan.confirm }) ?? "", /force_unsaved/);
  const calls: string[] = [];
  const result = await applyRecovery(plan, { confirm: plan.confirm, force_unsaved: true }, {
    log: (line) => calls.push(line),
    alive: () => false,
    closeGraceful: async () => "should not close a gone process",
    kill: async () => "should not kill",
    startRevit: async (_exe, files) => `started ${files.join("|")}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.writes_originals, false);
  assert.match(result.started, /Architecture\.rvt\|D:\\Fomcraft\\HEBERT\\Structural\.rvt/);
  assert.equal(result.closed.length, 0, "a process that is already gone is not killed");
  assert.match(result.verified[0].detail, /needs the add-in/i);
});

test("apply closes a hung process gracefully then kills it, and will not close one that is healthy", async () => {
  const hung = buildRecoveryPlan(input({
    processes: [revit(10, { responding: false })],
    portOpen: () => false,
    documents: [],
  }));
  assert.deepEqual(hung.would_close, [10]);
  let alive = true;
  const steps: string[] = [];
  const closed = await applyRecovery(hung, { confirm: hung.confirm, force_unsaved: true }, {
    log: () => {},
    alive: () => alive,
    closeGraceful: async (pid) => { steps.push(`grace ${pid}`); return "asked to close"; },
    kill: async (pid) => { steps.push(`kill ${pid}`); alive = false; return "killed"; },
    startRevit: async () => "started",
  });
  assert.deepEqual(steps, ["grace 10", "kill 10"]);
  assert.equal(closed.closed[0].killed, "killed");
  const healthy = buildRecoveryPlan(input());
  const blocked = await applyRecovery(healthy, { confirm: "nope" }, {
    log: () => {},
    alive: () => true,
    closeGraceful: async () => { throw new Error("closed a healthy instance"); },
    kill: async () => { throw new Error("killed a healthy instance"); },
    startRevit: async () => "no",
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message ?? "", /confirm token/);
});

test("in-flight leases are requeued at the tail and can resume", async () => {
  const board = new BatchBoard({ autoSweep: false, log: () => {} });
  const refs = { kit: ["k"], standards: ["s"], rulebook: ["r"] };
  const held = await board.request({ document: "Architecture", label: "grids", client: "a", references: refs });
  await board.request({ document: "Architecture", label: "walls", client: "b", references: refs });
  const moved = board.requeueForRecovery("Architecture");
  assert.equal(moved.requeued[0].lease, held.lease);
  assert.equal(moved.requeued[0].position, 2);
  const after = board.snapshot().documents as Array<{ holder: unknown; line: Array<{ label: string }> }>;
  assert.equal(after[0].holder, null);
  assert.deepEqual(after[0].line.map((row) => row.label), ["walls", "grids"]);
  const resumed = board.resumeAfterRecovery();
  assert.equal(resumed.length, 1);
  assert.equal((board.snapshot().documents as Array<{ holder: { label: string } }>)[0].holder.label, "walls");
});

test("recovery does not add a write command; verification stays a read", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_document_info"));
  assert.ok(!WRITE_COMMANDS.has("fmc_recover_revit"));
});
