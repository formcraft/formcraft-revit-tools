import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeBusyError, bridgeState, busyWords, parseBusy, retryWhileBusy, waitForBridgeFree } from "./busy.js";
import { gateA, parseRecipe } from "./recipes.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FAKE = path.join(REPO, "tests", "e2e", "fake_revit.mjs");
const JOB = "1792417040932222975";
// what plugin/Core/BridgeBusy.cs answers
const ADDIN = `[FMC-BRIDGE-BUSY] Revit is still running fmc_doc_flex since 2026-10-19 13:37:20 (job ${JOB}): its wait ended after 300 s, but the work goes on on Revit's API thread. Send this again once it has finished (fmc_job status ${JOB} follows it).`;

/** A clock and sleep that move only when slept, for the wait loops. */
function fakeTime(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, advance: (ms: number) => { t += ms; } };
}

test("F-072: the add-in's busy answer is recognised, in an error, a message or a reply body", () => {
  const b = parseBusy(new Error(ADDIN))!;
  assert.deepEqual(b, { command: "fmc_doc_flex", since: "2026-10-19 13:37:20", job: JOB });
  assert.deepEqual(parseBusy({ error: ADDIN }), b);
  assert.equal(busyWords(b), `Revit was busy with fmc_doc_flex since 2026-10-19 13:37:20 (job ${JOB})`);
  assert.equal(parseBusy(new Error("[FMC-BRIDGE-TIMEOUT] Revit didn't answer fmc_doc_close in 60 s")), null);
  assert.equal(parseBusy({ ok: true }), null);
  // the give-up error still carries the busy words, so the test runner knows it too
  assert.deepEqual(parseBusy(new BridgeBusyError(b, 60000, "ceiling", "fmc_doc_close")), b);
});

test("F-072: a busy answer is waited out and sent again while the busy job's heartbeats are fresh", async () => {
  const c = fakeTime();
  let calls = 0;
  const waits: number[] = [];
  const r = await retryWhileBusy(async () => { if (++calls <= 3) throw new Error(ADDIN); return "closed"; }, {
    command: "fmc_doc_close", ceilingMs: 60000, pollMs: 5000, heartbeatMs: () => c.now() - 30000, now: c.now, sleep: c.sleep,
    onWait: (_b, w) => waits.push(w),
  });
  assert.equal(r, "closed");
  assert.equal(calls, 4, "three busy answers, then the real one");
  assert.deepEqual(c.slept, [5000, 5000, 5000]);
  assert.deepEqual(waits, [0, 5000, 10000]);
});

test("F-072: the busy wait gives up at the caller's ceiling, saying what Revit is busy with", async () => {
  const c = fakeTime();
  let calls = 0;
  const err = await retryWhileBusy(async () => { calls++; throw new Error(ADDIN); }, {
    command: "fmc_family_host_test", ceilingMs: 20000, pollMs: 5000, heartbeatMs: () => c.now(), now: c.now, sleep: c.sleep,
  }).catch((e: unknown) => e);
  assert.ok(err instanceof BridgeBusyError);
  assert.equal((err as BridgeBusyError).why, "ceiling");
  assert.match((err as Error).message, /^\[FMC-BRIDGE-BUSY\] Revit is still running fmc_doc_flex since .* so fmc_family_host_test wasn't sent: waited 20 s.*time limit/);
  assert.equal(calls, 5, "sent at 0, 5, 10, 15 and 20 s; one more wait would pass the 20 s ceiling");
});

test("F-072: the busy wait stops when the busy job's heartbeats stop; other errors pass at once", async () => {
  const c = fakeTime();
  const hb = c.now() - 10 * 60 * 1000;   // the last heartbeat 10 minutes ago
  let calls = 0;
  const stale = await retryWhileBusy(async () => { calls++; c.advance(1000); throw new Error(ADDIN); }, {
    command: "fmc_doc_close", ceilingMs: 30 * 60 * 1000, pollMs: 60000, heartbeatMs: () => hb, now: c.now, sleep: c.sleep,
  }).catch((e: unknown) => e) as BridgeBusyError;
  // counted from the first busy answer: three minutes of no heartbeat, then it stops
  assert.equal(stale.why, "no heartbeat");
  assert.match(stale.message, /heartbeats for that job stopped/);
  assert.equal(calls, 4);

  let n = 0;
  const other = await retryWhileBusy(async () => { n++; throw new Error("fmc_doc_close: no session"); },
    { command: "fmc_doc_close", ceilingMs: 60000, heartbeatMs: () => 0, now: c.now, sleep: c.sleep }).catch((e: unknown) => e);
  assert.equal((other as Error).message, "fmc_doc_close: no session");
  assert.equal(n, 1);
});

test("F-072: Revit's job record says when its bridge is busy, for one Revit only", () => {
  const lines = [
    { at: "2026-10-19T13:37:40Z", job: JOB, command: "fmc_doc_flex", pid: 30436, event: "running", started: "2026-10-19T13:37:20Z" },
    { at: "2026-10-19T13:42:20Z", job: JOB, command: "fmc_doc_flex", pid: 30436, event: "bridge_busy", started: "2026-10-19T13:37:20Z" },
    { at: "2026-10-19T13:43:40Z", job: JOB, command: "fmc_doc_flex", pid: 30436, event: "heartbeat", started: "2026-10-19T13:37:20Z" },
    { at: "2026-10-19T13:43:41Z", job: "2", command: "x", pid: 999, event: "bridge_busy", started: "2026-10-19T13:43:00Z" },
  ];
  const b = bridgeState(lines, 30436)!;
  assert.equal(b.command, "fmc_doc_flex");
  assert.equal(b.job, JOB);
  assert.equal(b.heartbeat, Date.parse("2026-10-19T13:43:40Z"));
  assert.equal(bridgeState(lines, 1234), null, "another Revit's record is not this one's");
  assert.equal(bridgeState([...lines, { at: "2026-10-19T13:55:00Z", job: JOB, pid: 30436, event: "bridge_free" }], 30436), null);
  assert.equal(bridgeState([...lines, { at: "2026-10-19T13:55:00Z", job: JOB, pid: 30436, event: "finished" }], 30436), null);
});

test("F-072: the test runner waits for a busy Revit, bounded, and says why it stopped", async () => {
  const busy = { command: "fmc_doc_flex", since: "2026-10-19 13:37:20", job: JOB };
  // free after three looks
  let c = fakeTime();
  let looks = 0;
  let w = await waitForBridgeFree(() => (++looks < 4 ? { ...busy, heartbeat: c.now() } : null), { maxMs: 600000, pollMs: 15000, now: c.now, sleep: c.sleep });
  assert.equal(w.free, true);
  assert.equal(w.waitedMs, 45000);
  // still busy at the limit
  c = fakeTime();
  w = await waitForBridgeFree(() => ({ ...busy, heartbeat: c.now() }), { maxMs: 60000, pollMs: 15000, now: c.now, sleep: c.sleep });
  assert.deepEqual([w.free, w.why, w.busy], [false, "limit", busy]);
  // the busy job stopped sending heartbeats
  c = fakeTime();
  const hb = c.now();
  w = await waitForBridgeFree(() => ({ ...busy, heartbeat: hb }), { maxMs: 30 * 60000, pollMs: 60000, now: c.now, sleep: c.sleep });
  assert.equal(w.why, "no heartbeat");
  // Revit gone
  c = fakeTime();
  w = await waitForBridgeFree(() => ({ ...busy, heartbeat: c.now() }), { maxMs: 600000, now: c.now, sleep: c.sleep, alive: () => false });
  assert.equal(w.why, "revit gone");
  // a busy answer the record doesn't show (an older add-in): one poll, then free
  c = fakeTime();
  w = await waitForBridgeFree(() => null, { maxMs: 600000, pollMs: 15000, hint: busy, now: c.now, sleep: c.sleep });
  assert.deepEqual([w.free, c.slept], [true, [15000]]);
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}

async function withFake<T>(env: Record<string, string>, run: (port: number, log: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-busy-"));
  const log = path.join(dir, "calls.jsonl");
  const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_PORT: String(port), FAKE_LOG: log, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  try { return await run(port, log); } finally { child.kill(); }
}

test("F-072: the server's socket client waits out the add-in's busy answers (fake Revit), then gets the real one", async () => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-busy-home-"));
  fs.mkdirSync(path.join(appdata, "Formcraft"), { recursive: true });
  // the busy job's heartbeat, fresh
  fs.writeFileSync(path.join(appdata, "Formcraft", "FMC_Jobs_Revit.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), job: JOB, command: "fmc_doc_flex", pid: 1, event: "heartbeat" }) + "\n");
  const before = { APPDATA: process.env.APPDATA, POLL: process.env.FMC_BUSY_POLL_MS };
  process.env.APPDATA = appdata;
  process.env.FMC_BUSY_POLL_MS = "30";
  try {
    const { RevitClientConnection } = await import("../utils/SocketClient.js");
    await withFake({ FAKE_BUSY: "fmc_document_info:2" }, async (port, log) => {
      const client = new RevitClientConnection("127.0.0.1", port);
      await new Promise<void>((resolve) => { client.socket.once("connect", () => resolve()); client.connect(); });
      const info = await client.sendRaw("fmc_document_info", {}, 2000);
      assert.equal(info.active.title, "Project1");
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).method);
      assert.deepEqual(calls, ["fmc_document_info", "fmc_document_info", "fmc_document_info"], "two busy answers, then the real one");
      client.socket.destroy();
    });
    // still busy at the call's own limit: a clear busy error, not a timeout
    await withFake({ FAKE_BUSY: "1000" }, async (port) => {
      const client = new RevitClientConnection("127.0.0.1", port);
      await new Promise<void>((resolve) => { client.socket.once("connect", () => resolve()); client.connect(); });
      const err = await client.sendRaw("fmc_doc_close", { session: "s1" }, 300).catch((e: unknown) => e);
      assert.ok(err instanceof BridgeBusyError, String(err));
      assert.match((err as Error).message, /Revit is still running fmc_doc_flex .* so fmc_doc_close wasn't sent/);
      client.socket.destroy();
    });
  } finally {
    if (before.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = before.APPDATA;
    if (before.POLL === undefined) delete process.env.FMC_BUSY_POLL_MS; else process.env.FMC_BUSY_POLL_MS = before.POLL;
  }
});

test("F-072: a flex that stopped at its time limit adds a Warn line to Gate A and leaves the verdict as it was", () => {
  const recipe = parseRecipe(JSON.stringify({
    schema: "fmc-recipe/0.1", family: "FMC_A_Door_SteelFanlight", template: "Metric Door.rft",
    ops: [{ op: "set_category", name: "OST_Doors" }, { op: "add_type", name: "900x2100" }, { op: "add_type", name: "1000x2100" }],
    values: {}, checks: {},
  })).recipe;
  const inspect = { category: "Doors", checks: [{ check: "Name follows the kit", state: "pass", detail: "ok" }] };
  const done = gateA("FMC_A_Door_SteelFanlight", recipe, { inspect, flex: { ok: true, types: [{ type: "900x2100", ok: true }, { type: "1000x2100", ok: true }] }, registerCategory: "Doors" });
  const cut = gateA("FMC_A_Door_SteelFanlight", recipe, { inspect, registerCategory: "Doors",
    flex: { ok: true, types: [{ type: "900x2100", ok: true }], unfinished: { minutes: 4, checked: 1, of: 2 } } });
  const by = Object.fromEntries(cut.lines.map((l) => [l.check, l]));
  assert.equal(by["Flex finished"].state, "Warn");
  assert.equal(by["Flex finished"].detail, "flex not finished in 4 min: checked 1 of 2 types");
  assert.equal(by["Every type flexes"].detail, "1 of 2 types regenerate");
  assert.equal(cut.verdict, done.verdict);
  assert.deepEqual(cut.lines.filter((l) => l.check !== "Flex finished").map((l) => [l.check, l.state]), done.lines.map((l) => [l.check, l.state]));
  assert.equal(done.lines.some((l) => l.check === "Flex finished"), false, "a finished flex has no such line");
});
