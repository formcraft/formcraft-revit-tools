import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsage, recordUsage, summariseUsage } from "./usage.js";
import { approvalFor, claimApproval, enqueue, setStatus } from "./aiuse_io.js";

test("tool calls are recorded and summarised per build, newest build first, for an AI's own report", () => {
  const env = { APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-usage-")) };
  const at = (m: number) => new Date(Date.UTC(2026, 9, 26, 9, m)).toISOString();
  recordUsage({ at: at(0), tool: "create_line_based_element", action: "", ms: 41000, ok: true, build: "038d15f" }, env);
  recordUsage({ at: at(1), tool: "create_line_based_element", action: "", ms: 39000, ok: false, build: "038d15f" }, env);
  recordUsage({ at: at(5), tool: "create_line_based_element", action: "", ms: 12000, ok: true, build: "e1ddc12" }, env);
  recordUsage({ at: at(6), tool: "fmc_ai", action: "queue", ms: 300, ok: true, build: "e1ddc12" }, env);
  const s = summariseUsage(readUsage(env));
  assert.equal(s.calls, 4);
  assert.deepEqual(s.by_build.map((b) => b.build), ["e1ddc12", "038d15f"]);
  assert.equal(s.by_build[1].failures, 1);
  assert.equal(s.by_build[0].tools.find((t) => t.tool === "create_line_based_element")?.median_ms, 12000);
  assert.equal(s.by_build[0].tools.find((t) => t.tool === "fmc_ai queue")?.calls, 1);
  assert.equal(summariseUsage(readUsage(env), at(5)).calls, 2, "since");
  assert.deepEqual(readUsage({ APPDATA: path.join(env.APPDATA, "none") }), [], "nothing recorded yet");
});

test("wait: holds until a batch is decided, then tells the AI to go on (no turn ends while work remains)", async () => {
  const { waitFor } = await import("../tools/fmc_ai.js");
  const { setResult } = await import("./aiuse_io.js");
  const env = { ...process.env, APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-wait-")) };
  const saved = process.env.APPDATA;
  process.env.APPDATA = env.APPDATA;
  try {
    const item = enqueue("create_level", { elevations: [3400] }, path.win32.join("D:", "P", "01_WIP", "M.rvt"), "M", "levels_grids", 1);
    let t = 0;
    const clock = { sleep: async () => { t += 1000; }, now: () => t };
    const pending = await waitFor(item.id, 3, clock.sleep, clock.now);
    assert.equal(pending.status, "waiting");
    setStatus(item.id, "approved", "ama"); setResult(item.id, "done", "1 level");
    const done = await waitFor(item.id, 3, clock.sleep, clock.now);
    assert.equal(done.status, "done");
    assert.match(String(done.next), /next batch/);
    assert.match(String((await waitFor("ffffffff", 1, clock.sleep, clock.now)).error), /No batch/);
  } finally { process.env.APPDATA = saved; }
});

test("Replay fix (owner 26 Oct): an approval runs once, even when the first run timed out; a resend shows AGAIN", () => {
  const env = { ...process.env, APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-claim-")) };
  const doc = path.win32.join("D:", "P", "01_WIP", "M.rvt");
  const item = enqueue("create_room", { data: [1, 2] }, doc, "M", "architecture", 2, env);
  assert.equal(claimApproval(item.id, env), false, "pending can't run");
  setStatus(item.id, "approved", "me", env);
  assert.equal(claimApproval(item.id, env), true);
  assert.equal(claimApproval(item.id, env), false, "second run refused");
  assert.equal(approvalFor("create_room", { data: [1, 2] }, doc, env), null);
  assert.match(enqueue("create_room", { data: [1, 2] }, doc, "M", "architecture", 2, env).summary, /^AGAIN/);
});
