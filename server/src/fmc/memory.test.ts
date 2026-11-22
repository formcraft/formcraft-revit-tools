import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryGate, memoryLimits, type MemorySample } from "./memory.js";
import { BatchBoard } from "./batchline.js";

const refs = { kit: ["FMC_S_Column"], standards: ["structure.column.300"], rulebook: ["S.FND_01"] };

test("1024 MB pauses and memory above 1536 resumes", () => {
  assert.deepEqual(memoryLimits(undefined), { pauseMb: 1024, resumeMb: 1536 });
  assert.deepEqual(memoryLimits(0), { pauseMb: 0, resumeMb: 0 });
  let free = 2000;
  const logs: string[] = [];
  const gate = new MemoryGate(
    (): MemorySample => ({ freeMb: free, totalMb: 16000, revitWorkingSetMb: 4000, source: "os" }),
    () => memoryLimits(1024),
    (line) => logs.push(line),
    0,
  );
  assert.equal(gate.view().paused, false);
  assert.equal(gate.view().revit_working_set_mb, 4000);
  free = 1024;
  assert.equal(gate.view().paused, false, "1024 is not below 1024");
  free = 1023;
  assert.equal(gate.view().paused, true);
  assert.match(logs.at(-1) ?? "", /paused/);
  free = 1536;
  assert.equal(gate.view().paused, true, "1536 is not above 1536");
  free = 1537;
  assert.equal(gate.view().paused, false);
  assert.match(logs.at(-1) ?? "", /resumed/);
  free = 100;
  assert.equal(gate.view().paused, true);
  assert.equal(gate.view().tier, "hard");
  assert.equal(gate.view().code, "FMC-MEMORY-HARD");
  return assert.rejects(() => gate.holdWrites(0), /FMC-RAM-PAUSE/);
});

test("soft is the band between the two existing lines, and a heavy job is queued not failed", async () => {
  let free = 1400;
  const gate = new MemoryGate(
    (): MemorySample => ({ freeMb: free, totalMb: 16000, revitWorkingSetMb: 4000, source: "os" }),
    () => memoryLimits(1024),
    () => {},
    0,
  );
  assert.equal(gate.view().paused, false);
  assert.equal(gate.view().tier, "soft");
  assert.equal(gate.view().code, "FMC-MEMORY-SOFT");
  assert.equal(gate.leasesPaused(), false);
  assert.equal(gate.blocksNewLeases(), true);
  const { admitWrite, isHeavyWrite } = await import("./memory.js");
  assert.equal(isHeavyWrite("send_code_to_revit", { code: "return 1;" }), true);
  assert.equal(isHeavyWrite("create_level", {}), false);
  await assert.rejects(() => admitWrite(gate, "send_code_to_revit", { code: "x" }, 0), /FMC-MEMORY-SOFT/);
  await admitWrite(gate, "create_level", {}, 0);
  free = 1023;
  assert.equal(gate.view().tier, "hard");
  assert.equal(gate.view().paused, true);
  free = 1200;
  assert.equal(gate.view().paused, true, "the hard latch holds until above the resume line");
  assert.equal(gate.view().tier, "hard");
  free = 1537;
  assert.equal(gate.view().tier, "ok");
  assert.equal(gate.view().paused, false);
  free = 500;
  const off = new MemoryGate(
    (): MemorySample => ({ freeMb: free, totalMb: 16000, revitWorkingSetMb: null, source: "os" }),
    () => memoryLimits(0),
    () => {},
    0,
  );
  assert.equal(off.view().tier, "off");
  assert.equal(off.view().paused, false);
});

test("a lease stays queued while memory is paused and grants when it clears", async () => {
  let paused = true;
  const made = new BatchBoard({
    autoSweep: false,
    log: () => {},
    memoryPaused: () => paused,
    memoryView: () => ({ paused, free_mb: paused ? 800 : 2000, pause_below_mb: 1024, resume_above_mb: 1536 }),
  });
  const queued = await made.request({ document: "Architecture", label: "grids", client: "arch", references: refs });
  assert.equal(queued.state, "queued");
  assert.equal(queued.paused_for_memory, true);
  assert.match(String(queued.message), /Paused for memory/);
  assert.equal((queued.memory as { free_mb: number }).free_mb, 800);
  const waiting = made.wait(String(queued.lease), 2);
  paused = false;
  made.grantPaused();
  const granted = await waiting;
  assert.equal(granted.state, "granted");
  assert.equal(granted.paused_for_memory, undefined);
});
